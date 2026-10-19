import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "../readiness/format";
import { useGuardedMutate } from "../readiness/use-guarded";
import { PageHeader } from "../ui/page-header";
import { COMPLIANCE_KEYS, fixLink, useComplianceHolds, type ComplianceHold, riskLabel, type HoldShiftRisk } from "./queries";
import { clientLabel } from "../name-label";

/** Scheduled shifts whose CPR/TB is expired or expires during the shift. Shown whether or not a hold is open yet. */
function ShiftRisks({ risks }: { risks: HoldShiftRisk[] }) {
  if (risks.length === 0) return null;
  return (
    <Card className="p-4">
      <section aria-label="Shifts with CPR or TB expiring">
        <h2 className="text-base font-semibold text-slate-950">Shifts with CPR or TB expired or expiring ({new Set(risks.map((r) => r.shiftId)).size})</h2>
        <p className="mt-1 text-sm text-slate-700">Scheduled work where a required CPR or TB will not be valid for the whole shift. Nothing here was cancelled or moved, and a visit in progress is never ended by the system.</p>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {risks.map((r) => (
            <li key={`${r.shiftId}-${r.requirement}`} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span>
                <Link className="underline" to={`/care-team/${r.caregiverRecordId}`}>{r.caregiverName}</Link> · {formatDateTime(r.startsAt)} to {formatClockTime(r.endsAt)}{clientLabel(r, true) ? ` · ${clientLabel(r, true)}` : ""} · {riskLabel(r)}
                {r.inProgress ? <strong className="ml-1 text-red-800">In progress{r.visitId ? " (visit open)" : ""}</strong> : null}
                {r.onHold ? <span className="ml-1 text-slate-600">· caregiver is on hold</span> : null}
              </span>
              <Link className="underline" to="/schedule">Open the schedule</Link>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

function HoldCard({ h }: { h: ComplianceHold }) {
  return (
    <Card className="p-4">
      <article aria-label={`${h.caregiverName} on hold`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-950">
            <Link className="underline" to={`/care-team/${h.caregiverRecordId}`}>{h.caregiverName}</Link>
            <span className="ml-2 text-sm font-normal text-slate-600">{h.caregiverCode}</span>
          </h2>
          <span className="text-xs text-slate-600">Since {formatDateTime(h.openedAt)}{h.automatic ? " · automatic" : ""}</span>
        </div>

        {h.inProgressVisits.length > 0 ? (
          <div role="alert" className="mt-3 rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-950">
            <p className="font-semibold">A visit is in progress. Arrange safe coverage now.</p>
            <ul className="mt-1 list-disc pl-5">
              {h.inProgressVisits.map((v) => (
                <li key={v.visitId}>Started {formatDateTime(v.timeIn)}{clientLabel(v, true) ? ` · ${clientLabel(v, true)}` : ""}. The visit has not been ended and will not be.</li>
              ))}
            </ul>
          </div>
        ) : null}

        <section aria-label="Why" className="mt-3">
          <h3 className="text-sm font-semibold text-slate-900">Why</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-800">
            {h.reasons.map((r) => {
              const fix = fixLink(r, h.caregiverRecordId);
              return (
                <li key={`${r.requirement}-${r.code}`}>
                  {r.message} <Link className="underline" to={fix.to}>{fix.label}</Link>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Shifts to cover" className="mt-3">
          <h3 className="text-sm font-semibold text-slate-900">Shifts to cover ({h.affectedShifts.length})</h3>
          {h.affectedShifts.length === 0 ? <p className="mt-1 text-sm text-slate-600">No scheduled shifts are affected.</p> : (
            <ul className="mt-1 divide-y divide-slate-100 text-sm">
              {h.affectedShifts.map((s) => (
                <li key={s.shiftId} className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <span>{formatDateTime(s.startsAt)} to {formatClockTime(s.endsAt)}{clientLabel(s, true) ? ` · ${clientLabel(s, true)}` : ""}{s.seriesId ? " · recurring" : ""}{s.inProgress ? <strong className="ml-1 text-red-800">· in progress now{s.visitId ? " (visit open)" : ""}</strong> : null}</span>
                  <Link className="underline" to="/schedule">Open the schedule</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {h.affectedAssignments.length > 0 ? (
          <section aria-label="Standing assignments" className="mt-3">
            <h3 className="text-sm font-semibold text-slate-900">Standing assignments ({h.affectedAssignments.length})</h3>
            <ul className="mt-1 text-sm text-slate-800">
              {h.affectedAssignments.map((a) => (
                <li key={a.assignmentId}>{clientLabel(a, true) ?? "Client"} · from {formatDateOnly(a.effectiveStart)}{a.effectiveEnd ? ` to ${formatDateOnly(a.effectiveEnd)}` : ""}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="mt-3 text-xs text-slate-600">Nothing here was cancelled, moved or ended. Reassign or cancel a shift from the schedule; when the hold lifts, shifts you changed are not brought back.</p>
      </article>
    </Card>
  );
}

/** Action needed destination for caregivers on a compliance hold: the reason, the shifts to cover and any visit in progress. */
export function ComplianceHoldsPage() {
  const q = useComplianceHolds();
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const key = useRef(newIdempotencyKey());
  const check = useMutation({
    mutationFn: () => api.post<{ result: { evaluated: number; holdsOpened: number; holdsReleased: number } }>("/v1/compliance/sweep", { organizationId: activeOrganizationId }, { idempotencyKey: key.current }),
    onSuccess: async () => {
      key.current = newIdempotencyKey();
      await Promise.all(COMPLIANCE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    },
  });
  const send = useGuardedMutate(check);
  if (!hasPermission("readiness.read")) return <p className="text-sm text-og-sub">You do not have access to compliance holds.</p>;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Caregiver holds"
        lead="Caregivers who cannot be given new work or start visits until a requirement is verified. These are the agency's own rules, not legal requirements."
        action={hasPermission("caregivers.manage") || hasPermission("caregivers.compliance.manage")
          ? <Button type="button" variant="secondary" disabled={check.isPending} onClick={() => send()}>{check.isPending ? "Checking…" : "Check now"}</Button>
          : undefined}
      />
      {check.isSuccess ? <p role="status" className="text-sm text-og-sub">Checked {check.data.result.evaluated} caregivers. {check.data.result.holdsOpened} new, {check.data.result.holdsReleased} lifted.</p> : null}
      {check.isError ? <p role="alert" className="text-sm text-red-700">{actionError(check.error, "The check could not run.")}</p> : null}
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Holds could not be loaded.")}</p> : null}
      {q.data ? (
        q.data.holds.length === 0 ? (
          <>
            <Card className="p-4"><p role="status" className="text-sm text-slate-800">No caregiver is on a compliance hold.</p></Card>
            <ShiftRisks risks={q.data.shiftsAtRisk ?? []} />
          </>
        ) : (
          <>
            <p className="text-sm text-slate-800">{q.data.totals.holds} on hold · {q.data.totals.affectedShifts} shift{q.data.totals.affectedShifts === 1 ? "" : "s"} to cover · {q.data.totals.inProgressVisits} visit{q.data.totals.inProgressVisits === 1 ? "" : "s"} in progress</p>
            {q.data.holds.map((h) => <HoldCard key={h.holdId} h={h} />)}
            <ShiftRisks risks={q.data.shiftsAtRisk ?? []} />
          </>
        )
      ) : null}
    </div>
  );
}
