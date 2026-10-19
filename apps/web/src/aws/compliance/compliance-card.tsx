import { Disclosure } from "../ui/disclosure";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "../readiness/format";
import { SummarySection } from "../ui/summary-section";
import { InfoTip } from "../ui/info-tip";
import { CompactAlert } from "../ui/compact-alert";
import { actionBtn, linkClass } from "../ui-classes";
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

const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

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
    <form className="mt-1 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end" aria-label="Set hire date" onSubmit={(e) => { e.preventDefault(); if (ready && !mutation.isPending) send({ hireDate: date, reason: reason.trim() }); }}>
      <label className="block text-xs font-medium text-slate-800">Hire date
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); freshKey(); }} className={inputClass} />
      </label>
      <label className="block text-xs font-medium text-slate-800">Reason (kept in the audit trail)
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
    <form className="mt-1 space-y-1.5" aria-label="Background check status" onSubmit={(e) => { e.preventDefault(); if (status !== c.background.status && !mutation.isPending) send({ status, note: note.trim() || null }); }}>
      <label className="block text-xs font-medium text-slate-800">Where the check stands
        <select value={status} onChange={(e) => { setStatus(e.target.value); freshKey(); }} className={inputClass}>
          {Object.entries(BACKGROUND_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-slate-800">Note (optional)
        <input value={note} onChange={(e) => { setNote(e.target.value); freshKey(); }} maxLength={500} className={inputClass} />
      </label>
      <p className="flex items-center gap-1.5 text-xs text-slate-600">Tracks progress only.<InfoTip>This tracks progress only. “Completed” does not clear the caregiver; an administrator must verify an approved result.</InfoTip></p>
      {withdraws ? <CompactAlert summary="Approval withdrawn until verified again">Moving an approved check back to {BACKGROUND_STATUS_LABEL[status]?.toLowerCase()} withdraws the approval until it is verified again.</CompactAlert> : null}
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
    <form className="mt-2 space-y-1.5 border-t border-slate-200 pt-2" aria-label="Verify background check" onSubmit={(e) => { e.preventDefault(); if (ready && !mutation.isPending) send({ result, evidenceNote: evidence.trim() }); }}>
      <fieldset>
        <legend className="text-xs font-medium text-slate-800">Result confirmed by the agency</legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name="bg-result" checked={result === "approved"} onChange={() => { setResult("approved"); freshKey(); }} />Approved</label>
        <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="bg-result" checked={result === "not_approved"} onChange={() => { setResult("not_approved"); freshKey(); }} />Not approved</label>
      </fieldset>
      <label className="block text-xs font-medium text-slate-800">Where you confirmed it
        <input value={evidence} onChange={(e) => { setEvidence(e.target.value); freshKey(); }} maxLength={500} className={inputClass} />
      </label>
      <p className="flex items-center gap-1.5 text-xs text-slate-600">Record where you saw the clearance.<InfoTip>Write where you saw the clearance, not what the report says. Your name and the time are recorded. You cannot verify your own check.</InfoTip></p>
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
  const [openForm, setOpenForm] = useState<"hire" | "bg" | null>(typeof window !== "undefined" && window.location.hash.slice(1) === "hire-date" ? "hire" : typeof window !== "undefined" && window.location.hash.slice(1) === "background-check" ? "bg" : null);
  // A link from Action needed or the holds page lands on #background-check or #hire-date; scroll there once the card has loaded.
  useEffect(() => {
    const id = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (q.data && (id === "background-check" || id === "hire-date" || id === "compliance")) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [q.data]);
  if (!canRead) return null;
  const isAdmin = hasPermission("caregivers.compliance.manage");
  const canTrack = isAdmin || hasPermission("caregivers.manage");
  const c = q.data;
  type Tone = "ok" | "bad" | "info";
  const rank: Record<Tone, number> = { bad: 0, info: 1, ok: 2 };
  const rows: Array<{ id: string; anchor?: string; label: string; tone: Tone; chip: string; value: React.ReactNode; action?: React.ReactNode; alert?: React.ReactNode }> = [];
  if (c) {
    const toggle = (k: "hire" | "bg", label: string) => <button type="button" className={`${actionBtn} md:min-h-7 md:py-0`} aria-expanded={openForm === k} onClick={() => setOpenForm(openForm === k ? null : k)}>{openForm === k ? "Close" : label}</button>;
    rows.push({
      id: "hire", anchor: "hire-date", label: "Hire date", tone: c.hireDate ? "ok" : c.hireDateRequired ? "bad" : "info", chip: c.hireDate ? "Recorded" : "Missing",
      value: <>{c.hireDate ? formatDateOnly(c.hireDate) : "Not recorded"} · CPR and TB due: {c.dueDate ? formatDateOnly(c.dueDate) : "Cannot be set without a hire date"}</>,
      action: canTrack && (isAdmin || !c.hireDate) ? toggle("hire", c.hireDate ? "Change" : "Set hire date") : c.hireDate ? <span className="text-xs text-slate-600">Only an administrator can change a recorded hire date.</span> : undefined,
      alert: <>{!c.hireDate && c.hireDateRequired ? <CompactAlert tone="danger" className="mt-1" summary="Hire date missing">No hire date is recorded, so the {c.graceDays}-day period cannot be applied. CPR and TB must be verified now.</CompactAlert> : null}
        <Disclosure summary="How the deadline is calculated">
                  {c.dueDate ? <p>The due date is the last day. A hold starts at 12:00 AM on {formatDateOnly(nextDay(c.dueDate))} ({c.timezone ?? "agency time zone"}).</p> : null}
                  <p className="mt-1">{c.deadlineRule}</p>
                </Disclosure></>,
    });
    rows.push({
      id: "bg", anchor: "background-check", label: "Background check", tone: c.background.qualifies ? "ok" : "bad", chip: c.background.qualifies ? "Approved and verified" : "Not cleared",
      value: <>Status: {BACKGROUND_STATUS_LABEL[c.background.status] ?? c.background.status}{c.background.result ? ` · Result: ${c.background.result === "approved" ? "Approved" : "Not approved"}` : " · No result recorded"}{c.background.verifiedAt ? ` · Verified by ${c.background.verifiedByName ?? "an administrator"} on ${formatDateTime(c.background.verifiedAt)}${c.background.evidenceNote ? `. Confirmed in: ${c.background.evidenceNote}` : ""}` : ""}</>,
      action: canTrack || isAdmin ? toggle("bg", isAdmin ? "Update or verify" : "Update status") : undefined,
      alert: !c.background.qualifies && c.background.state === "completed_not_approved" ? <CompactAlert tone="danger" className="mt-1" summary="Completed, no approved result verified">The check is completed but no approved result is verified yet, so the caregiver cannot be assigned.</CompactAlert> : undefined,
    });
    for (const r of c.requirements) {
      rows.push({
        id: `req-${r.requirement}`, label: r.requirement.toUpperCase(), tone: r.current ? "ok" : r.pending ? "info" : "bad",
        chip: r.current ? "Current" : r.pending ? `Pending, due ${formatDateOnly(r.dueDate)}` : "Missing or not current",
        value: r.current ? `Verified${r.validUntil ? `, valid through ${formatDateOnly(r.validUntil)}` : ""}` : r.message ?? "Not current",
        action: !r.current ? <Link className={linkClass} to="/documents">Open documents</Link> : undefined,
      });
    }
    rows.push({ id: "enf", label: "Enforcement", tone: "info", chip: c.enforcementActive ? "On" : "Off", value: c.enforcementActive ? "Checks block assignments." : "Enforcement is not on for this agency yet. These checks are shown but do not block assignments." });
    rows.sort((x, y) => rank[x.tone] - rank[y.tone]);
  }
  const head = c ? headline(c) : null;
  const anchored = typeof window !== "undefined" && ["compliance", "background-check", "hire-date"].includes(window.location.hash.slice(1));
  return (
    <SummarySection title="Compliance" defaultOpen={anchored || (!!c && (!!c.hold || !c.eligible))}
      status={head ? <Pill tone={head.tone}>{head.label}</Pill> : undefined}
      summary={c ? (c.hold ? `${c.hold.reasons.length} item${c.hold.reasons.length === 1 ? "" : "s"} to fix` : c.eligible ? undefined : "Fix the items inside") : undefined}>
      <section aria-labelledby="compliance-heading" id="compliance">
        <h3 id="compliance-heading" className="sr-only">Compliance details</h3>
        {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {q.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{actionError(q.error, "Compliance could not be loaded.")}</p> : null}
        {c ? (
          <div className="mt-1 space-y-2">
            {c.hold ? (
              <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-sm text-red-950">
                <p className="font-semibold">On compliance hold since {formatDateTime(c.hold.openedAt)}{c.hold.automatic ? " (automatic)" : ""}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
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
                <p className="mt-1 flex items-center gap-1.5 text-xs">Lifts when every item is resolved.<InfoTip>The hold lifts by itself when every item above is resolved. Shifts that were cancelled or reassigned meanwhile are not brought back.</InfoTip></p>
              </div>
            ) : !c.eligible ? (
              <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm text-amber-950">
                <p className="font-semibold">{c.enforcementActive ? "Not eligible for new work. The hold record appears at the next check." : "Not eligible under the rules."}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {c.background.qualifies ? null : <li>Background check clearance is not verified as approved.</li>}
                  {c.requirements.filter((r) => r.blocking).map((r) => <li key={r.requirement}>{r.message}</li>)}
                </ul>
              </div>
            ) : null}

            <ul aria-label="Compliance status" className="divide-y divide-slate-200 rounded-md border border-slate-200 text-sm">
              {rows.map((r) => (
                <li key={r.id} id={r.anchor} className="px-2 py-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="w-32 shrink-0 font-medium text-slate-900">{r.label}</span>
                    <Pill tone={r.tone}>{r.chip}</Pill>
                    <span className="min-w-0 flex-1 text-slate-700">{r.value}</span>
                    {r.action}
                  </div>
                  {r.alert}
                </li>
              ))}
            </ul>

            {openForm === "hire" ? (
              <section aria-label="Hire date panel" className="space-y-1 rounded-md bg-slate-50 p-2">
                {c.hold ? <p className="flex items-center gap-1.5 text-xs text-slate-700">A hire date does not release a hold.<InfoTip>While a hold is open, entering or changing the hire date does not release it. It is released only when every requirement below is verified.</InfoTip></p> : null}
                {canTrack && (isAdmin || !c.hireDate) ? <HireDateForm key={c.hireDate ?? "none"} c={c} /> : c.hireDate ? <p className="text-xs text-slate-600">Only an administrator can change a recorded hire date.</p> : null}
              </section>
            ) : null}

            {openForm === "bg" ? (
              <section aria-label="Background check panel" className="space-y-1 rounded-md bg-slate-50 p-2">
                {canTrack ? <BackgroundStatusForm key={`${c.background.status}-${c.background.verifiedAt ?? ""}`} c={c} /> : null}
                {isAdmin ? <VerifyForm key={c.background.verifiedAt ?? "none"} c={c} /> : canTrack ? <p className="text-xs text-slate-600">Only an administrator can record the verified result.</p> : null}
              </section>
            ) : null}

            {(c.shiftRisks ?? []).length > 0 ? (
              <section aria-label="Shifts affected by CPR or TB expiry">
                <h3 className="text-sm font-semibold text-slate-900">Scheduled shifts where CPR or TB expires ({new Set((c.shiftRisks ?? []).map((s) => s.shiftId)).size})</h3>
                <ul className="mt-0.5 space-y-0.5 text-sm text-slate-800">
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
    </SummarySection>
  );
}
