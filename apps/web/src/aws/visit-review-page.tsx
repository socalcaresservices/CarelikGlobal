// One visit, with why it needs review and what can be done about it (0031).
// Opening this page changes nothing. A review decision is a separate, audited
// record with a reason; it never creates a signature, never raises billable
// minutes, and never approves billing (that stays a separate human step).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import {
  confirmationMethodLabel,
  FLEXIBLE_VISIT_LABEL,
  formatClockTime,
  formatDateOnly,
  formatDateTime,
  formatDuration,
  UNLINKED_VISIT_LABEL,
  VISIT_STATUS_LABEL,
  type ServiceVisitStatus,
} from "@/lib/service-verification";
import { newIdempotencyKey, type BillingState } from "@/lib/sv-backend";
import { APPROVAL_STATUS_LABEL } from "./billing-format";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { AuthorizationReviewCard } from "./authorization-review-card";
import { SignatureRecoveryCard } from "./signature-recovery";

interface VisitReview {
  visitId: string;
  visitNumber: string | null;
  visitStatus: ServiceVisitStatus;
  clientId: string;
  clientCode: string;
  clientName: string | null;
  caregiverName: string;
  serviceCode: string;
  serviceName: string;
  serviceDate: string;
  timeIn: string;
  timeOut: string | null;
  workedMinutes: number | null;
  verifiedMinutes: number | null;
  billableMinutes: number | null;
  authorizationStatus: string | null;
  scheduledStartsAt: string | null;
  scheduledEndsAt: string | null;
  caregiverSchedulingMode: string | null;
  confirmationMethod: string | null;
  signerRole: string | null;
  signerName: string | null;
  signerRelationship: string | null;
  confirmationReason: string | null;
  confirmedAt: string | null;
  hasSignatureEvidence: boolean;
  isCorrection: boolean;
  reviewReasons: string[];
  decisionId: string | null;
  decision: "accept_capped_billable" | "close_not_billable" | "accept_late_confirmation" | null;
  decisionReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  activeBillingApprovalId: string | null;
  approvedMinutes: number | null;
  canDecide: boolean;
  allowedDecisions: Array<"accept_capped_billable" | "close_not_billable">;
  /** 0036: missing-signature recovery. */
  recoveryState?: "awaiting_response" | "response_to_review" | null;
  canRequestConfirmation?: boolean;
  decisionAcceptedMinutes?: number | null;
  /** 0062: the server's billing state; null for someone who may not see billing. */
  billingState?: BillingState | null;
  /** Wave 1 (0050). */
  unscheduledReason?: string | null;
  ruleVersion?: number | null;
  ruleMinutes?: number | null;
  ruleSource?: "system_default" | "agency_setting" | null;
  ruleOutcome?: "within" | "over" | "not_applicable" | null;
  attestationVersion?: string | null;
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

const DECISION_LABEL: Record<string, string> = {
  accept_capped_billable: "Accept the billable minutes within the authorization",
  close_not_billable: "Close the review: not billable",
  accept_late_confirmation: "Late confirmation accepted",
};
const DECISION_EXPLAIN: Record<string, string> = {
  accept_capped_billable:
    "The client signed or marked the visit. Only the minutes that fit within the authorization become eligible; the minutes over it stay not billable. Billing still needs its own approval.",
  close_not_billable:
    "Records that the review is finished and nothing more is billable for this visit. The visit and its times are not changed. It can be revoked later with a reason (for example, if a signature is obtained). You do not have to close it: you can ask for the signature instead (below).",
};

/** Wave 1: when the review is about an unscheduled visit or a schedule difference, the first decision accepts the visit as worked. */
const isScheduleReview = (v: VisitReview) => v.reviewReasons.includes("unscheduled") || v.reviewReasons.includes("schedule_variance");
const decisionLabel = (d: string, v: VisitReview) =>
  d === "accept_capped_billable" && isScheduleReview(v) ? "Accept this visit as worked (minutes within the authorization)" : DECISION_LABEL[d];
const decisionExplain = (d: string, v: VisitReview) =>
  d === "accept_capped_billable" && isScheduleReview(v)
    ? "Records that you reviewed the schedule difference and accept the visit as worked. Only the minutes that fit within the authorization become eligible; the minutes over it stay not billable. Billing still needs its own approval."
    : DECISION_EXPLAIN[d];

function reasonText(reason: string, v: VisitReview): string {
  if (reason === "unscheduled") {
    return `Started with no scheduled shift. Reason given by the caregiver: “${v.unscheduledReason ?? "not recorded"}”. It stays provisional until you review it.`;
  }
  if (reason === "schedule_variance") {
    const sched = v.scheduledStartsAt && v.scheduledEndsAt ? Math.round((new Date(v.scheduledEndsAt).getTime() - new Date(v.scheduledStartsAt).getTime()) / 60000) : null;
    return `Worked ${formatDuration(v.workedMinutes)} against a scheduled ${sched === null ? "shift" : formatDuration(sched)}: more than the ${v.ruleMinutes ?? "?"}-minute difference the agency allows${v.ruleSource === "system_default" ? " (a starting value no one has verified for your payer)" : ""}.`;
  }
  if (reason === "no_client_signature") {
    return v.confirmationMethod === "unable_to_confirm"
      ? "The client or representative did not confirm the visit, so it has 0 billable minutes."
      : `Confirmed by ${confirmationMethodLabel(v.confirmationMethod).toLowerCase()} without a drawn signature or mark, so it has 0 billable minutes.`;
  }
  if (reason === "over_authorization") {
    const over = (v.workedMinutes ?? 0) - (v.billableMinutes ?? 0);
    return `Worked ${formatDuration(v.workedMinutes)}, but only ${formatDuration(v.billableMinutes)} fit within this month's authorization; ${formatDuration(over)} is over it and not billable.`;
  }
  return reason;
}

export function VisitReviewPage() {
  const { visitId = "" } = useParams();
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const query = useQuery({
    queryKey: ["visit-review", visitId],
    queryFn: async () => (await api.get<{ visit: VisitReview }>(`/v1/visits/${encodeURIComponent(visitId)}/review`, { organizationId: activeOrganizationId })).visit,
    enabled: !!visitId && !!activeOrganizationId,
  });
  const [choice, setChoice] = useState<string>("");
  const [reason, setReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["visit-review", visitId] }),
      queryClient.invalidateQueries({ queryKey: ["aws-attention"] }),
    ]);
  }

  async function decide() {
    if (!choice) return setState({ busy: false, error: "Choose what to record.", done: null });
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give the reason for this decision.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/visits/${encodeURIComponent(visitId)}/review-decision`, { organizationId: activeOrganizationId, decision: choice, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setChoice("");
      setReason("");
      setState({ busy: false, error: null, done: "Review decision recorded. The visit record is unchanged." });
      await refresh();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The decision was not saved."), done: null });
    }
  }

  async function revoke(decisionId: string) {
    if (revokeReason.trim().length < 3) return setState({ busy: false, error: "Give the reason for revoking.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/visit-review-decisions/${encodeURIComponent(decisionId)}/revoke`, { organizationId: activeOrganizationId, reason: revokeReason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setRevokeReason("");
      setState({ busy: false, error: null, done: "Decision revoked. The visit needs review again." });
      await refresh();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The decision was not revoked."), done: null });
    }
  }

  if (query.isLoading) return <p className="text-sm text-slate-500">Loading visit…</p>;
  if (query.isError || !query.data) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-red-700">{query.isError ? message(query.error, "This visit could not be loaded.") : "Visit not found."}</p>
        <Link to="/service-verification/reports" className="text-sm underline">Back to visit records</Link>
      </div>
    );
  }
  const v = query.data;
  const inReview = v.visitStatus === "administrator_review";
  const scheduled = v.scheduledStartsAt && v.scheduledEndsAt
    ? `${formatClockTime(v.scheduledStartsAt)}–${formatClockTime(v.scheduledEndsAt)}`
    : v.caregiverSchedulingMode === "flexible" ? FLEXIBLE_VISIT_LABEL : UNLINKED_VISIT_LABEL;
  const facts: Array<[string, string]> = [
    ...(v.clientName ? [["Client code", v.clientCode] as [string, string]] : []),
    ["Caregiver", v.caregiverName],
    ["Service", `${v.serviceName} (${v.serviceCode})`],
    ["Date", formatDateOnly(v.serviceDate)],
    ["Actual times", `${formatClockTime(v.timeIn)} – ${v.timeOut ? formatClockTime(v.timeOut) : "still open"}`],
    ["Scheduled", scheduled],
    ["Worked", formatDuration(v.workedMinutes)],
    ["Billable", v.decision === "accept_late_confirmation" ? `${formatDuration(v.billableMinutes)} on the original record` : formatDuration(v.billableMinutes)],
    ...(v.decision === "accept_late_confirmation" ? [["Eligible for approval", `${formatDuration(v.decisionAcceptedMinutes)} (from the accepted late confirmation)`] as [string, string]] : []),
    ["Confirmation", confirmationMethodLabel(v.confirmationMethod)],
  ];
  if (v.signerName) facts.push(["Confirmed by", `${v.signerName}${v.signerRelationship ? ` (${v.signerRelationship})` : ""}`]);
  if (v.confirmationReason) facts.push([v.confirmationMethod === "unable_to_confirm" ? "No-signer reason" : "Confirmation note", v.confirmationReason]);
  if (v.confirmedAt) facts.push(["Confirmed", formatDateTime(v.confirmedAt)]);
  if (v.unscheduledReason) facts.push(["Unscheduled reason", v.unscheduledReason]);
  if (v.ruleMinutes !== undefined && v.ruleMinutes !== null && v.ruleOutcome && v.ruleOutcome !== "not_applicable") {
    facts.push(["Schedule rule used", `${v.ruleMinutes} minutes (version ${v.ruleVersion}, ${v.ruleSource === "system_default" ? "starting value, not verified" : "set by your agency"}): ${v.ruleOutcome === "over" ? "difference over the rule" : "within the rule"}`]);
  }
  if (v.attestationVersion !== undefined) facts.push(["Caregiver attestation", v.attestationVersion ? `Recorded (${v.attestationVersion})` : "Not recorded"]);
  facts.push(["Signature on file", v.hasSignatureEvidence ? "Yes" : "No"]);
  facts.push(["Billing approval", v.activeBillingApprovalId ? `Approved for Billing: ${formatDuration(v.approvedMinutes)} — not submitted or paid` : v.billingState === "voided" ? "Voided (an earlier approval was voided; it can be approved again)" : "Not approved"]);

  return (
    <div className="space-y-4">
      <div>
        <Link to="/service-verification/reports" className="text-sm text-slate-600 underline">Visit records</Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-950">{v.clientName ?? v.clientCode}</h1>
        <p className="mt-1">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${inReview && !v.decision ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200" : "bg-slate-100 text-slate-700"}`}>
            {v.billingState
              ? APPROVAL_STATUS_LABEL[v.billingState]
              : inReview
              ? v.decision
                ? v.decision === "close_not_billable" ? "Reviewed — not billable" : v.decision === "accept_late_confirmation" ? "Late confirmation accepted — eligible for billing approval" : "Reviewed — capped minutes eligible"
                : v.recoveryState === "awaiting_response" ? "Waiting for signature" : v.recoveryState === "response_to_review" ? "Signature received — review it" : "In review"
              : VISIT_STATUS_LABEL[v.visitStatus]}
          </span>
        </p>
      </div>

      <Card className="p-4">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {facts.map(([k, val]) => (
            <div key={k} className="contents">
              <dt className="text-slate-500">{k}</dt>
              <dd className="break-words font-medium text-slate-900">{val}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-3 text-xs text-slate-500">
          <summary className="inline-flex min-h-6 cursor-pointer items-center [@media(pointer:coarse)]:min-h-[44px]">Visit reference</summary>
          <p className="mt-1 font-mono">{v.visitNumber ?? v.visitId}</p>
        </details>
      </Card>

      {inReview ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-semibold text-slate-950">Why this visit needs review</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
            {v.reviewReasons.map((r) => <li key={r}>{reasonText(r, v)}</li>)}
          </ul>
          {v.reviewReasons.includes("no_client_signature") && !v.decision ? (
            <details className="text-xs text-slate-600">
              <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">About the missing signature</summary>
              <p>The original visit record and its confirmation are never changed. A signature obtained later is kept as a separate record and reviewed by a person (see “Get the missing signature” below).</p>
            </details>
          ) : null}

          {v.decision ? (
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <p className="font-medium text-slate-900">
                {decisionLabel(v.decision, v)}
                {v.decision === "accept_late_confirmation" ? ` — ${formatDuration(v.decisionAcceptedMinutes)} eligible for billing approval` : ""}
              </p>
              <p className="text-slate-700">“{v.decisionReason}”</p>
              <p className="text-xs text-slate-500">{v.decidedByName} · {v.decidedAt ? formatDateTime(v.decidedAt) : ""}</p>
              {v.canDecide && v.decisionId ? (
                <div className="mt-3 space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    Reason for revoking
                    <input value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} maxLength={1000} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                  </label>
                  <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void revoke(v.decisionId!)}>Revoke decision</Button>
                  {v.activeBillingApprovalId ? <p className="text-xs text-slate-500">Void the billing approval first; a decision behind an approval cannot be revoked.</p> : null}
                </div>
              ) : null}
            </div>
          ) : v.canDecide && v.allowedDecisions.length > 0 ? (
            <form onSubmit={(e) => { e.preventDefault(); void decide(); }} className="space-y-3">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-700">Record a review decision</legend>
                {v.allowedDecisions.map((d) => (
                  <label key={d} className="flex gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                    <input type="radio" name="decision" value={d} checked={choice === d} onChange={() => setChoice(d)} className="mt-1" />
                    <span>
                      <span className="font-medium text-slate-900">{decisionLabel(d, v)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <details className="text-xs text-slate-600">
                <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">What each choice does</summary>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {v.allowedDecisions.map((d) => <li key={d}>{decisionExplain(d, v)}</li>)}
                </ul>
              </details>
              <label className="block text-sm font-medium text-slate-700">
                Reason (required, kept in the audit trail)
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <Button type="submit" disabled={state.busy} className="min-h-[44px]">Record decision</Button>
            </form>
          ) : v.recoveryState ? (
            <p className="text-sm text-slate-600">
              {v.recoveryState === "awaiting_response"
                ? "A confirmation has been requested. To close the review instead, revoke the request first."
                : "A response came in. Review it below before recording anything else."}
            </p>
          ) : (
            <p className="text-sm text-slate-600">You can see this review but not record a decision.</p>
          )}
        </Card>
      ) : null}

      <AuthorizationReviewCard visitId={v.visitId} />

      {inReview && v.reviewReasons.includes("no_client_signature") && activeOrganizationId ? (
        <SignatureRecoveryCard
          visitId={v.visitId}
          organizationId={activeOrganizationId}
          canManage={v.canDecide}
          canRequest={!!v.canRequestConfirmation}
          recoveryState={v.recoveryState ?? null}
          workedMinutes={v.workedMinutes}
        />
      ) : null}

      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
        <Link className="font-medium underline" to={`/service-verification/reports?view=visits&correct=${encodeURIComponent(v.visitId)}`}>Correct</Link>
        <Link className="font-medium underline" to="/billing-review">Billing review</Link>
      </p>
      <details className="text-xs text-slate-600">
        <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">What these links do</summary>
        <p>Correct creates a corrected record and keeps the original; it is separate from review. Billing review is where billable minutes are approved.</p>
      </details>
    </div>
  );
}
