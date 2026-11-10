import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nameWithCode } from "./name-label";
import { useState } from "react";
import { Link } from "react-router-dom";
import { RoundingSection } from "./billing-rounding";
import { APPROVAL_STATUS_CLASS, APPROVAL_STATUS_LABEL, APPROVAL_STATUS_NOTE, approvableMinutes, billingStateOf, formatClock, formatDuration, formatUsDate, visitScheduleLabel, type ApprovalStatus } from "./billing-format";
import { activeFilterCount, applyBillingFilters, filterOptions, NO_FILTERS, type BillingFilters } from "./billing-filters";
import { Button, Card } from "@carelik/ui";
import { ShortHelp } from "./help-text";
import { InfoTip } from "./ui/info-tip";
import { CompactAlert } from "./ui/compact-alert";
import { confirmationMethodLabel, formatHours } from "@/lib/service-verification";
import { useIsNarrow } from "@/lib/use-is-narrow";
import { newIdempotencyKey, type BillingApprovalRow, type BillingReviewRow } from "@/lib/sv-backend";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import { useOrganization } from "@/providers/organization-provider";

function monthBounds(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
}


const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** One open form at a time. The idempotency key is fixed when the form opens, so a retry cannot approve twice. */
type Pending =
  | { kind: "approve"; row: BillingReviewRow; minutes: string; notes: string; key: string; busy: boolean; error: string | null }
  | { kind: "void"; approval: BillingApprovalRow; reason: string; key: string; busy: boolean; error: string | null };

/**
 * Billing review and human billing approval. Ready for Review means the automatic
 * checks passed; a person with billing.approve then approves the billable
 * minutes. Approval is not payer submission. Dollar amounts appear only for
 * holders of billing.read (owner); the server returns null to everyone else.
 */
export function BillingReviewPage() {
  const backend = useServiceVerificationBackend();
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const tz = (activeOrganization as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  const [{ from, to }, setRange] = useState(monthBounds);
  const [signature, setSignature] = useState<{ visitId: string; url: string | null; error: string | null } | null>(null);
  const canRead = hasPermission("billing.visits.read");
  const canApprove = hasPermission("billing.approve") && !!backend.approveVisitForBilling;
  const canSeeMoney = hasPermission("billing.read");
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const narrow = useIsNarrow();
  const [filters, setFilters] = useState<BillingFilters>(NO_FILTERS);

  const query = useQuery({
    queryKey: ["aws-billing-review", activeOrganizationId, from, to],
    queryFn: () => backend.listBillingReview!(activeOrganizationId!, from, to),
    enabled: !!activeOrganizationId && canRead && !!backend.listBillingReview,
  });
  const approvalsQuery = useQuery({
    queryKey: ["aws-billing-approvals", activeOrganizationId, from, to],
    queryFn: () => backend.listBillingApprovals!(activeOrganizationId!, from, to),
    enabled: !!activeOrganizationId && canRead && !!backend.listBillingApprovals,
  });
  const activeApproval = new Map<string, BillingApprovalRow>();
  for (const a of approvalsQuery.data ?? []) if (!a.voidedAt) activeApproval.set(a.visitId, a);

  async function submitPending() {
    if (!pending || pending.busy) return;
    if (pending.kind === "approve") {
      const minutes = Number(pending.minutes);
      const max = approvableMinutes(pending.row);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > max) {
        setPending({ ...pending, error: `Enter whole minutes from 0 to ${max}.` });
        return;
      }
      setPending({ ...pending, busy: true, error: null });
      try {
        await backend.approveVisitForBilling!({ visitId: pending.row.visitId, approvedMinutes: minutes, notes: pending.notes.trim() || null, idempotencyKey: pending.key });
        setNotice(`Visit ${pending.row.visitNumber ?? ""} is Approved for Billing (${formatHours(minutes)} h). It has not been submitted or paid.`);
        setPending(null);
      } catch (cause) {
        setPending({ ...pending, busy: false, error: cause instanceof Error ? cause.message : "Approval failed. Nothing was approved; try again." });
        return;
      }
    } else {
      if (!pending.reason.trim()) {
        setPending({ ...pending, error: "A reason is required." });
        return;
      }
      setPending({ ...pending, busy: true, error: null });
      try {
        await backend.voidBillingApproval!({ billingApprovalId: pending.approval.billingApprovalId, reason: pending.reason.trim(), idempotencyKey: pending.key });
        setNotice(`Approval for visit ${pending.approval.visitNumber ?? ""} voided. The visit shows as Voided and can be approved again.`);
        setPending(null);
      } catch (cause) {
        setPending({ ...pending, busy: false, error: cause instanceof Error ? cause.message : "Void failed. The approval still stands; try again." });
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["aws-billing-approvals"] });
    await queryClient.invalidateQueries({ queryKey: ["aws-billing-review"] });
  }

  async function showSignature(visitId: string) {
    setSignature({ visitId, url: null, error: null });
    try {
      setSignature({ visitId, url: await backend.getSignatureDataUrl!(visitId), error: null });
    } catch (cause) {
      setSignature({ visitId, url: null, error: cause instanceof Error ? cause.message : "Could not load the signature." });
    }
  }

  function evidenceCell(r: BillingReviewRow) {
    return <>{r.hasSignatureEvidence ? (
                      <Button type="button" variant="secondary" className="min-h-[28px] whitespace-nowrap px-2 py-0.5 text-xs [@media(pointer:coarse)]:min-h-[44px]" onClick={() => void showSignature(r.visitId)}>View signature</Button>
                    ) : (
                      confirmationMethodLabel(r.confirmationMethod)
                    )}</>;
  }
  function approvalCell(r: BillingReviewRow) {
    return <>{(() => {
                      const a = activeApproval.get(r.visitId);
                      if (a) {
                        return (
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <p className="font-medium text-emerald-800">Approved {formatHours(a.approvedMinutes)} h <span className="text-xs font-normal text-slate-500">by {a.approvedByName} · not submitted or paid</span></p>
                            {canApprove ? (
                              <button type="button" className="text-xs text-slate-600 underline" onClick={() => { setNotice(null); setPending({ kind: "void", approval: a, reason: "", key: newIdempotencyKey(), busy: false, error: null }); }}>
                                Void approval
                              </button>
                            ) : null}
                          </div>
                        );
                      }
                      const state = approvalStatus(r);
                      if (state === "reviewed_not_billable") {
                        return <span className="text-slate-600">Reviewed — not billable</span>;
                      }
                      if (state !== "ready_for_review" && state !== "voided") {
                        return (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {(r.reviewReasons ?? []).includes("authorization_decreased") ? (
                              <CompactAlert testId="authorization-decreased" summary="Authorization lowered after confirmation">The authorization was lowered after this visit was confirmed. The visit and its minutes are unchanged; confirm it is still billable, or correct it.</CompactAlert>
                            ) : null}
                            <Link to={`/visits/${r.visitId}`} className="inline-flex min-h-[28px] items-center whitespace-nowrap rounded-md border border-amber-600 px-2 text-xs font-medium [@media(pointer:coarse)]:min-h-[44px] text-amber-900 hover:bg-amber-50">
                              {state === "needs_correction" ? "Correct or resolve" : "Review"}
                            </Link>
                          </div>
                        );
                      }
                      if (!canApprove) return <span className="text-slate-500">Not approved</span>;
                      return (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {state === "voided" ? (
                            <p data-testid="void-history" className="text-xs text-rose-800">
                              Approval voided{r.lastVoidAt ? ` ${formatUsDate(r.lastVoidAt)}` : ""}{r.lastVoidedByName ? ` by ${r.lastVoidedByName}` : ""}{r.lastVoidReason ? `: ${r.lastVoidReason}` : ""}
                            </p>
                          ) : null}
                        <Button type="button" className="min-h-[28px] whitespace-nowrap px-3 py-0.5 text-xs [@media(pointer:coarse)]:min-h-[44px]" onClick={() => { setNotice(null); setPending({ kind: "approve", row: r, minutes: String(approvableMinutes(r)), notes: "", key: newIdempotencyKey(), busy: false, error: null }); }}>
                          Approve
                        </Button>
                        </div>
                      );
                    })()}</>;
  }
  function amountCell(r: BillingReviewRow) {
    return <>{(() => {
                        const a = activeApproval.get(r.visitId);
                        if (!a) return "—";
                        return a.amountCents === null ? <span className="text-slate-500">Rate not set</span> : money(a.amountCents);
                      })()}</>;
  }

  function approvalStatus(r: BillingReviewRow): ApprovalStatus {
    return billingStateOf(r, !!activeApproval.get(r.visitId));
  }
  /** One word with a symbol-free chip. In the table (compact) the note is not a second line: it stays in the page for screen readers and as a hover title. */
  function statusPill(r: BillingReviewRow, compact = false) {
    const st = approvalStatus(r);
    const note = APPROVAL_STATUS_NOTE[st] && st !== "ready_for_review" && st !== "approved_for_billing" ? APPROVAL_STATUS_NOTE[st] : null;
    return (
      <span className={compact ? "inline-flex items-center gap-1 whitespace-nowrap" : "inline-flex flex-col items-start gap-0.5"} title={compact && note ? note : undefined}>
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_STATUS_CLASS[st]}`}>{APPROVAL_STATUS_LABEL[st]}</span>
        {note ? <span className={compact ? "sr-only" : "text-[11px] text-slate-600"}>{note}</span> : null}
      </span>
    );
  }
  function clientCell(r: BillingReviewRow) {
    const code = r.clientCode ?? null;
    return (
      <div>
        <p className="max-w-[14rem] break-words font-semibold text-slate-950" title={r.clientName ?? undefined}>{r.clientName ? nameWithCode(r.clientName, code, r.clientNameDuplicate) : code ?? "Client"}</p>
      </div>
    );
  }
  const serviceText = (r: BillingReviewRow) => (r.serviceName ? `${r.serviceName} (${r.serviceCode})` : r.serviceCode);
  const timesText = (r: BillingReviewRow) => (r.timeIn ? `${formatClock(r.timeIn, tz)} – ${formatClock(r.timeOut, tz)}` : "");
  const whenText = (r: BillingReviewRow) => `${formatUsDate(r.serviceDate)}${r.timeIn ? `, ${timesText(r)}` : ""}`;
  const minutesText = (r: BillingReviewRow) =>
    r.billableMinutes === r.workedMinutes ? `${formatDuration(r.workedMinutes)} worked and billable` : `${formatDuration(r.workedMinutes)} worked, ${formatDuration(r.billableMinutes)} billable`;
  function detailsCell(r: BillingReviewRow, compact = false) {
    return (
      <details className={compact ? "text-xs text-slate-600 open:basis-full" : "text-xs text-slate-600"}>
        <summary className="inline-flex min-h-5 cursor-pointer items-center whitespace-nowrap select-none text-slate-700 underline [@media(pointer:coarse)]:min-h-[44px]">Visit details</summary>
        <div className="mt-1 whitespace-normal">
          <p className="font-mono break-all">Visit {r.visitNumber ?? "—"}{r.isCorrection ? " (corrected)" : ""}</p>
          <p>{visitScheduleLabel(r.caregiverSchedulingMode, r.scheduledShiftId)}</p>
          {r.authorizationVersion ? <p>Authorization version {r.authorizationVersion}</p> : null}
        </div>
      </details>
    );
  }

  if (!canRead) return <p className="text-sm text-slate-600">You do not have access to billing review.</p>;

  const loaded = query.data ?? [];
  const rows = applyBillingFilters(loaded, filters, approvalStatus);
  const options = filterOptions(loaded, approvalStatus);
  const nFilters = activeFilterCount(filters);
  const setFilter = (key: keyof BillingFilters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const selects: Array<{ key: keyof BillingFilters; label: string; all: string; opts: Array<[string, string]> }> = [
    { key: "client", label: "Client", all: "All clients", opts: options.clients },
    { key: "caregiver", label: "Caregiver", all: "All caregivers", opts: options.caregivers },
    { key: "service", label: "Service", all: "All services", opts: options.services },
    { key: "visitStatus", label: "Visit status", all: "All visit statuses", opts: options.visitStatuses },
    { key: "approval", label: "Approval status", all: "All approval statuses", opts: options.approvals },
  ];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
       <div className="flex items-center gap-1.5">
        <h1 className="text-xl font-bold text-slate-950">Billing review</h1>
        <InfoTip label="About billing review">Approve each Ready for Review visit; approval is not submission or payment. Ready for Review means the visit passed the automatic checks. Approved for Billing is a separate human step. Nothing is sent to a payer from this screen.</InfoTip>
       </div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">From
          <input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="block min-h-[44px] md:min-h-[32px] rounded-md border border-slate-200 px-2 py-1 text-sm [@media(pointer:coarse)]:min-h-[44px]" />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">To
          <input type="date" value={to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="block min-h-[44px] md:min-h-[32px] rounded-md border border-slate-200 px-2 py-1 text-sm [@media(pointer:coarse)]:min-h-[44px]" />
        </label>
      </div>
      {loaded.length > 0 ? (
        // Filter records = which visits are listed. (Visit records also has Show/hide columns, which only changes what is displayed.)
        <details open={nFilters > 0} className="rounded-lg border border-slate-200 bg-og-card px-3 py-1.5">
          <summary className="flex min-h-[28px] cursor-pointer select-none items-center text-sm font-medium text-slate-800 [@media(pointer:coarse)]:min-h-[44px]">
            Filters{nFilters > 0 ? ` (${nFilters} active)` : ""}
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
            {selects.map((x) => (
              <label key={x.key} className="text-xs font-medium text-slate-600">
                {x.label}
                <select
                  value={filters[x.key]}
                  onChange={setFilter(x.key)}
                  className={`mt-0.5 block min-h-[44px] md:min-h-[32px] w-full min-w-0 rounded-md border px-2 py-1 text-sm [@media(pointer:coarse)]:min-h-[44px] ${filters[x.key] ? "border-sky-600 bg-sky-50" : "border-slate-200"}`}
                >
                  <option value="">{x.all}</option>
                  {x.opts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span role="status">
              {nFilters > 0 ? `Showing ${rows.length} of ${loaded.length} visits in this date range` : `${loaded.length} ${loaded.length === 1 ? "visit" : "visits"} in this date range`}
            </span>
            {nFilters > 0 ? <button type="button" onClick={() => setFilters(NO_FILTERS)} className="font-medium text-sky-700 underline">Clear filters</button> : null}
          </div>
        </details>
      ) : null}
      {query.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {query.isError ? <p role="alert" className="text-sm text-red-700">{(query.error as Error).message}</p> : null}
      {approvalsQuery.isError ? <p role="alert" className="text-sm text-red-700">Approvals could not be loaded: {(approvalsQuery.error as Error).message}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      {!query.isLoading && !query.isError && loaded.length === 0 ? <p className="text-sm text-slate-500">No signed or review visits in this range.</p> : null}
      {loaded.length > 0 && rows.length === 0 ? <p className="text-sm text-slate-500">No visits match these filters. <button type="button" onClick={() => setFilters(NO_FILTERS)} className="font-medium text-sky-700 underline">Clear filters</button></p> : null}
      {rows.length > 0 && narrow ? (
        <ul aria-label="Billing review visits" className="space-y-3">
          {rows.map((r) => (
            <li key={r.visitId} className="rounded-xl border border-slate-200 bg-og-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                {clientCell(r)}
                {statusPill(r)}
              </div>
              <p className="mt-1 text-sm text-slate-800">{r.caregiverName ?? "—"} · {serviceText(r)}</p>
              <p className="text-sm text-slate-800">{whenText(r)} · {minutesText(r)}</p>
              <div className="mt-2 text-sm">{approvalCell(r)}</div>
              <details className="mt-2 text-sm">
                <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-og-accent underline">More</summary>
                <div className="space-y-2">
                  <div>{evidenceCell(r)}</div>
                  {canSeeMoney ? <p className="text-slate-700">Amount: {amountCell(r)}</p> : null}
                  {detailsCell(r)}
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > 0 && !narrow ? (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-2 py-1">Client</th>
                <th scope="col" className="px-2 py-1">Caregiver · service</th>
                <th scope="col" className="px-2 py-1">Date and time</th>
                <th scope="col" className="px-2 py-1">Worked / billable</th>
                <th scope="col" className="px-2 py-1">Evidence</th>
                <th scope="col" className="px-2 py-1">Approval</th>
                {canSeeMoney ? <th scope="col" className="px-2 py-1">Amount</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.visitId} className="border-t border-slate-100 align-middle">
                  <td className="px-2 py-0.5"><div className="flex flex-wrap items-center gap-x-2"><span className="max-w-[11rem] break-words">{clientCell(r)}</span><span className="whitespace-nowrap">{statusPill(r, true)}</span></div></td>
                  <td className="max-w-[11rem] px-2 py-0.5" title={`${r.caregiverName ?? "—"} · ${serviceText(r)}`}>{r.caregiverName ?? "—"} <span className="text-slate-600">· {serviceText(r)}</span></td>
                  <td className="px-2 py-0.5" title={`${formatUsDate(r.serviceDate)} ${timesText(r)}`}>{formatUsDate(r.serviceDate)} <span className="text-slate-600">{timesText(r)}</span></td>
                  <td className="px-2 py-0.5" title={`${formatDuration(r.workedMinutes)}${r.billableMinutes !== r.workedMinutes ? ` · billable ${formatDuration(r.billableMinutes)}` : ""}`}>{formatDuration(r.workedMinutes)}{r.billableMinutes !== r.workedMinutes ? <span className="text-slate-600"> · billable {formatDuration(r.billableMinutes)}</span> : null}</td>
                  <td className="px-2 py-0.5"><div className="flex items-center gap-x-2 whitespace-nowrap">{evidenceCell(r)}{detailsCell(r, true)}</div></td>
                  <td className="px-2 py-0.5">{approvalCell(r)}</td>
                  {canSeeMoney ? <td className="px-2 py-0.5">{amountCell(r)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {pending ? (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); void submitPending(); }} className="space-y-3">
            {pending.kind === "approve" ? (
              <>
                <p className="text-sm font-medium text-slate-900">Approve visit {pending.row.visitNumber ?? ""} for billing</p>
                <ShortHelp
                  className="text-xs text-slate-600"
                  details="Approval records your name and the time. It does not submit anything to a payer and does not mean it was paid."
                >
                  {pending.row.reviewDecision === "accept_late_confirmation" ? "Accepted from a late confirmation" : "Billable"}: {approvableMinutes(pending.row)} min ({formatHours(approvableMinutes(pending.row))} h). You can approve less, never more.
                </ShortHelp>
                <label className="block text-xs font-medium text-slate-600">
                  Approved minutes
                  <input inputMode="numeric" value={pending.minutes} onChange={(e) => setPending({ ...pending, minutes: e.target.value, error: null })} className="mt-1 block w-32 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Note (optional)
                  <input value={pending.notes} maxLength={1000} onChange={(e) => setPending({ ...pending, notes: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-900">Void the billing approval for visit {pending.approval.visitNumber ?? ""}</p>
                <p className="text-xs text-slate-600">The approval stays in the record as voided, with your reason. The visit shows as Voided and can be approved again.</p>
                <label className="block text-xs font-medium text-slate-600">
                  Reason (required)
                  <input value={pending.reason} maxLength={1000} onChange={(e) => setPending({ ...pending, reason: e.target.value, error: null })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </>
            )}
            {pending.error ? <p role="alert" className="text-sm text-red-700">{pending.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending.busy}>
                {pending.busy ? "Saving…" : pending.kind === "approve" ? "Approve for billing" : "Void approval"}
              </Button>
              <Button type="button" variant="secondary" disabled={pending.busy} onClick={() => setPending(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <RoundingSection from={from} to={to} refreshKey={approvalsQuery.dataUpdatedAt} />
      {signature ? (
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">Client signature</p>
            <button type="button" className="text-xs text-slate-500 underline" onClick={() => setSignature(null)}>Close</button>
          </div>
          {signature.error ? <p role="alert" className="mt-2 text-sm text-red-700">{signature.error}</p> : null}
          {signature.url ? <img src={signature.url} alt="Client signature for the selected visit" className="mt-3 max-h-48 rounded border border-slate-200 bg-og-card" /> : null}
          {!signature.url && !signature.error ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
