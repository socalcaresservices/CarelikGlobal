import { Disclosure } from "../ui/disclosure";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "../readiness/format";
import { useGuardedMutate } from "../readiness/use-guarded";
import {
  riskLabel,
  BACKGROUND_STATUS_LABEL,
  COMPLIANCE_KEYS,
  fixLink,
  nextDay,
  useCaregiverCompliance,
  type CaregiverComplianceState,
} from "./queries";

const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base";

/** One place to send a change and refresh everything that shows compliance (profile, holds, Action needed, readiness report). */
function useComplianceMutation<V>(path: string, body: (v: V) => Record<string, unknown>, onDone?: () => void) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const mutation = useMutation({
    mutationFn: (v: V) => api.post(path, { organizationId: activeOrganizationId, ...body(v) }, { idempotencyKey: key.current }),
    onSuccess: async () => {
      key.current = newIdempotencyKey();
      await Promise.all(COMPLIANCE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onDone?.();
    },
  });
  return { mutation, send: useGuardedMutate(mutation), freshKey: () => { key.current = newIdempotencyKey(); } };
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: string }) {
  const cls = { ok: "bg-emerald-100 text-emerald-950", warn: "bg-amber-100 text-amber-950", bad: "bg-red-100 text-red-950", info: "bg-sky-100 text-sky-950" }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function headline(c: CaregiverComplianceState): { tone: "ok" | "warn" | "bad" | "info"; label: string } {
  if (c.hold) return { tone: "bad", label: "On compliance hold" };
  if (!c.eligible && !c.enforcementActive) return { tone: "warn", label: "Would be held once enforcement is on" };
  if (!c.eligible) return { tone: "bad", label: "Blocked from new work" };
  if (c.requirements.some((r) => r.pending)) return { tone: "info", label: "Eligible: requirements pending" };
  return { tone: "ok", label: "Eligible" };
}

function HireDateForm({ c }: { c: CaregiverComplianceState }) {
  const [date, setDate] = useState(c.hireDate ?? "");
  const [reason, setReason] = useState("");
  const { mutation, send, freshKey } = useComplianceMutation(
    `/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/hire-date`,
    (v: { hireDate: string; reason: string }) => v,
    () => setReason(""),
  );
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(date) && reason.trim().length >= 3 && date !== c.hireDate;
  return (
    <form className="mt-2 space-y-2" aria-label="Set hire date" onSubmit={(e) => { e.preventDefault(); if (ready && !mutation.isPending) send({ hireDate: date, reason: reason.trim() }); }}>
      <label className="block text-sm font-medium text-slate-800">Hire date
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); freshKey(); }} className={inputClass} />
      </label>
      <label className="block text-sm font-medium text-slate-800">Reason (kept in the audit trail)
        <input value={reason} onChange={(e) => { setReason(e.target.value); freshKey(); }} maxLength={500} className={inputClass} />
      </label>
      {mutation.isError ? <p role="alert" className="text-sm text-red-700">{actionError(mutation.error, "The hire date could not be saved.")}</p> : null}
      <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Saving…" : c.hireDate ? "Change hire date" : "Save hire date"}</Button>
    </form>
  );
}

function BackgroundStatusForm({ c }: { c: CaregiverComplianceState }) {
  const [status, setStatus] = useState(c.background.status);
  const [note, setNote] = useState("");
  const { mutation, send, freshKey } = useComplianceMutation(
    `/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/background-check/status`,
    (v: { status: string; note: string | null }) => v,
    () => setNote(""),
  );
  const withdraws = c.background.qualifies && status !== "completed";
  return (
    <form className="mt-2 space-y-2" aria-label="Background check status" onSubmit={(e) => { e.preventDefault(); if (status !== c.background.status && !mutation.isPending) send({ status, note: note.trim() || null }); }}>
      <label className="block text-sm font-medium text-slate-800">Where the check stands
        <select value={status} onChange={(e) => { setStatus(e.target.value); freshKey(); }} className={inputClass}>
          {Object.entries(BACKGROUND_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-800">Note (optional)
        <input value={note} onChange={(e) => { setNote(e.target.value); freshKey(); }} maxLength={500} className={inputClass} />
      </label>
      <p className="text-xs text-slate-600">This tracks progress only. “Completed” does not clear the caregiver; an administrator must verify an approved result.</p>
      {withdraws ? <p className="text-xs font-medium text-amber-900">Moving an approved check back to {BACKGROUND_STATUS_LABEL[status]?.toLowerCase()} withdraws the approval until it is verified again.</p> : null}
      {mutation.isError ? <p role="alert" className="text-sm text-red-700">{actionError(mutation.error, "The status could not be saved.")}</p> : null}
      <Button type="submit" variant="secondary" disabled={status === c.background.status || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save status"}</Button>
    </form>
  );
}

function VerifyForm({ c }: { c: CaregiverComplianceState }) {
  const [result, setResult] = useState<"approved" | "not_approved">("approved");
  const [evidence, setEvidence] = useState("");
  const { mutation, send, freshKey } = useComplianceMutation(
    `/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/background-check/verify`,
    (v: { result: string; evidenceNote: string }) => v,
    () => setEvidence(""),
  );
  const ready = evidence.trim().length >= 3;
  return (
    <form className="mt-3 space-y-2 border-t border-slate-200 pt-3" aria-label="Verify background check" onSubmit={(e) => { e.preventDefault(); if (ready && !mutation.isPending) send({ result, evidenceNote: evidence.trim() }); }}>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Result confirmed by the agency</legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name="bg-result" checked={result === "approved"} onChange={() => { setResult("approved"); freshKey(); }} />Approved</label>
        <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="bg-result" checked={result === "not_approved"} onChange={() => { setResult("not_approved"); freshKey(); }} />Not approved</label>
      </fieldset>
      <label className="block text-sm font-medium text-slate-800">Where you confirmed it
        <input value={evidence} onChange={(e) => { setEvidence(e.target.value); freshKey(); }} maxLength={500} className={inputClass} />
      </label>
      <p className="text-xs text-slate-600">Write where you saw the clearance, not what the report says. Your name and the time are recorded. You cannot verify your own check.</p>
      {mutation.isError ? <p role="alert" className="text-sm text-red-700">{actionError(mutation.error, "The result could not be recorded.")}</p> : null}
      <Button type="submit" disabled={!ready || mutation.isPending}>{mutation.isPending ? "Recording…" : "Record verified result"}</Button>
    </form>
  );
}

/**
 * Compliance on the Care Team profile: eligibility, the hire date with its exact deadline, the background check, CPR and TB, and the
 * hold with its exact reasons and a link to fix each. The rules are owner-defined (not stated as legal requirements). Staff only.
 */
export function CaregiverCompliance({ caregiverRecordId }: { caregiverRecordId: string }) {
  const { hasPermission } = useOrganization();
  const canRead = hasPermission("readiness.read") || hasPermission("caregivers.manage") || hasPermission("caregivers.compliance.manage");
  const q = useCaregiverCompliance(caregiverRecordId, canRead);
  // A link from Action needed or the holds page lands on #background-check or #hire-date; scroll there once the card has loaded.
  useEffect(() => {
    const id = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (q.data && (id === "background-check" || id === "hire-date" || id === "compliance")) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [q.data]);
  if (!canRead) return null;
  const isAdmin = hasPermission("caregivers.compliance.manage");
  const canTrack = isAdmin || hasPermission("caregivers.manage");
  const c = q.data;
  const head = c ? headline(c) : null;
  return (
    <Card className="p-4" >
      <section aria-labelledby="compliance-heading" id="compliance">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="compliance-heading" className="text-base font-semibold text-slate-950">Compliance</h2>
          {head ? <Pill tone={head.tone}>{head.label}</Pill> : null}
        </div>
        {q.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
        {q.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{actionError(q.error, "Compliance could not be loaded.")}</p> : null}
        {c ? (
          <div className="mt-3 space-y-4">
            {!c.enforcementActive ? (
              <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-950">Enforcement is not on for this agency yet. These checks are shown but do not block assignments.</p>
            ) : null}

            {c.hold ? (
              <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950">
                <p className="font-semibold">On compliance hold since {formatDateTime(c.hold.openedAt)}{c.hold.automatic ? " (automatic)" : ""}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {c.hold.reasons.map((r) => {
                    const fix = fixLink(r, c.caregiverRecordId);
                    return (
                      <li key={`${r.requirement}-${r.code}`}>
                        {r.message}{" "}
                        {fix.to.startsWith("/care-team/") ? <a className="underline" href={fix.to.slice(fix.to.indexOf("#"))}>{fix.label}</a> : <Link className="underline" to={fix.to}>{fix.label}</Link>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs">The hold lifts by itself when every item above is resolved. Shifts that were cancelled or reassigned meanwhile are not brought back.</p>
              </div>
            ) : !c.eligible ? (
              <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">{c.enforcementActive ? "Not eligible for new work. The hold record appears at the next check." : "Not eligible under the rules."}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {c.background.qualifies ? null : <li>Background check clearance is not verified as approved.</li>}
                  {c.requirements.filter((r) => r.blocking).map((r) => <li key={r.requirement}>{r.message}</li>)}
                </ul>
              </div>
            ) : null}

            <section aria-labelledby="hire-date-heading" id="hire-date">
              <h3 id="hire-date-heading" className="text-sm font-semibold text-slate-900">Hire date and CPR/TB deadline</h3>
              <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                <div><dt className="inline text-slate-600">Hire date: </dt><dd className="inline">{c.hireDate ? formatDateOnly(c.hireDate) : "Not recorded"}</dd></div>
                <div><dt className="inline text-slate-600">CPR and TB due: </dt><dd className="inline">{c.dueDate ? formatDateOnly(c.dueDate) : "Cannot be set without a hire date"}</dd></div>
              </dl>
              {!c.hireDate && c.hireDateRequired ? <p className="mt-1 text-sm font-medium text-red-800">No hire date is recorded, so the {c.graceDays}-day period cannot be applied. CPR and TB must be verified now.</p> : null}
              <Disclosure summary="How the deadline is calculated">
                {c.dueDate ? <p>The due date is the last day. A hold starts at 12:00 AM on {formatDateOnly(nextDay(c.dueDate))} ({c.timezone ?? "agency time zone"}).</p> : null}
                <p className="mt-1">{c.deadlineRule}</p>
              </Disclosure>
              {c.hold ? <p className="mt-1 text-xs text-slate-700">While a hold is open, entering or changing the hire date does not release it. It is released only when every requirement below is verified.</p> : null}
              {canTrack && (isAdmin || !c.hireDate) ? <HireDateForm key={c.hireDate ?? "none"} c={c} /> : c.hireDate ? <p className="mt-1 text-xs text-slate-600">Only an administrator can change a recorded hire date.</p> : null}
            </section>

            <section aria-labelledby="bg-heading" id="background-check">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="bg-heading" className="text-sm font-semibold text-slate-900">Background check</h3>
                <Pill tone={c.background.qualifies ? "ok" : "bad"}>{c.background.qualifies ? "Approved and verified" : "Not cleared"}</Pill>
              </div>
              <p className="mt-1 text-sm text-slate-700">
                Status: {BACKGROUND_STATUS_LABEL[c.background.status] ?? c.background.status}
                {c.background.result ? ` · Result: ${c.background.result === "approved" ? "Approved" : "Not approved"}` : " · No result recorded"}
              </p>
              {c.background.verifiedAt ? <p className="text-xs text-slate-600">Verified by {c.background.verifiedByName ?? "an administrator"} on {formatDateTime(c.background.verifiedAt)}{c.background.evidenceNote ? `. Confirmed in: ${c.background.evidenceNote}` : ""}</p> : null}
              {!c.background.qualifies && c.background.state === "completed_not_approved" ? <p className="mt-1 text-sm text-red-800">The check is completed but no approved result is verified yet, so the caregiver cannot be assigned.</p> : null}
              {canTrack ? <BackgroundStatusForm key={`${c.background.status}-${c.background.verifiedAt ?? ""}`} c={c} /> : null}
              {isAdmin ? <VerifyForm key={c.background.verifiedAt ?? "none"} c={c} /> : canTrack ? <p className="mt-2 text-xs text-slate-600">Only an administrator can record the verified result.</p> : null}
            </section>

            <section aria-label="CPR and TB">
              <h3 className="text-sm font-semibold text-slate-900">CPR and TB</h3>
              <ul className="mt-1 space-y-2">
                {c.requirements.map((r) => (
                  <li key={r.requirement} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                    <div>
                      <p className="font-medium text-slate-900">{r.requirement.toUpperCase()}</p>
                      <p className="text-slate-700">
                        {r.current ? `Verified${r.validUntil ? `, valid through ${formatDateOnly(r.validUntil)}` : ""}` : r.message ?? "Not current"}
                      </p>
                      {!r.current ? <Link className="text-sm underline" to="/documents">Open documents</Link> : null}
                    </div>
                    <Pill tone={r.current ? "ok" : r.pending ? "info" : "bad"}>{r.current ? "Current" : r.pending ? `Pending, due ${formatDateOnly(r.dueDate)}` : "Missing or not current"}</Pill>
                  </li>
                ))}
              </ul>
            </section>

            {(c.shiftRisks ?? []).length > 0 ? (
              <section aria-label="Shifts affected by CPR or TB expiry">
                <h3 className="text-sm font-semibold text-slate-900">Scheduled shifts where CPR or TB expires ({new Set((c.shiftRisks ?? []).map((s) => s.shiftId)).size})</h3>
                <ul className="mt-1 space-y-1 text-sm text-slate-800">
                  {(c.shiftRisks ?? []).map((s) => (
                    <li key={`${s.shiftId}-${s.requirement}`}>
                      {formatDateTime(s.startsAt)} to {formatClockTime(s.endsAt)} · {riskLabel(s)}
                      {s.inProgress ? <strong className="ml-1 text-red-800">· in progress now. The visit will not be ended.</strong> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    </Card>
  );
}
