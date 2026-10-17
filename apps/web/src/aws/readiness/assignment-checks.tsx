import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { CHECK_GROUPS, actionError, groupOutcome, type CheckRow } from "./format";
import { ShortHelp } from "../help-text";


export interface AssignmentCheckInput {
  caregiverRecordId: string;
  serviceId: string;
  clientId?: string;
  /** Agency-local date and times, as typed on the schedule screen. An end earlier than the start means the next day. */
  date?: string;
  startTime?: string;
  endTime?: string;
  /** Or exact instants (an ISO timestamp with an offset), for a shift that already exists. */
  startsAt?: string;
  endsAt?: string;
  context?: "shift" | "reschedule";
  excludeShiftId?: string;
}

interface Evaluation { startsAt: string; endsAt: string; ready: boolean; wouldBlockAfterActivation: boolean; checks: CheckRow[] }

const STATE_TEXT = { ok: "OK", blocked: "", would_block: "", overridden: "", not_checked: "Not checked" } as const;

/**
 * The four separate checks before a caregiver is committed: Availability, Approved services, Documents, Conflicts.
 * Messages are the server's exact words. "Ready to assign" appears only when every check that is enforced passes,
 * and the parent is told (onReady) so it can keep a blocked caregiver from being assigned.
 */
export function AssignmentChecks({ input, onReady }: { input: AssignmentCheckInput | null; onReady?: (ready: boolean | null) => void }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const key = useRef(newIdempotencyKey());
  const enabled = !!activeOrganizationId && !!input && !!input.caregiverRecordId && !!input.serviceId && ((!!input.date && !!input.startTime && !!input.endTime) || (!!input.startsAt && !!input.endsAt));
  const q = useQuery({
    queryKey: ["assignment-checks", activeOrganizationId, input],
    queryFn: async () => (await api.post<{ evaluation: Evaluation }>("/v1/readiness/evaluate", {
      organizationId: activeOrganizationId, caregiverRecordId: input!.caregiverRecordId, serviceId: input!.serviceId, clientId: input!.clientId,
      ...(input!.startsAt ? { startsAt: input!.startsAt, endsAt: input!.endsAt } : { date: input!.date, startTime: input!.startTime, endTime: input!.endTime }),
      context: input!.context ?? "shift", excludeShiftId: input!.excludeShiftId,
    })).evaluation,
    enabled,
    retry: false,
  });
  useEffect(() => { onReady?.(!enabled ? null : q.isLoading ? null : q.isError ? false : q.data?.ready ?? null); }, [enabled, q.isLoading, q.isError, q.data, onReady]);
  const override = useMutation({
    mutationFn: () => api.post("/v1/availability/overrides", { organizationId: activeOrganizationId, caregiverRecordId: input!.caregiverRecordId, clientId: input!.clientId, rangeStart: q.data!.startsAt, rangeEnd: q.data!.endsAt, reason: reason.trim() }, { idempotencyKey: key.current }),
    onSuccess: () => { setOverriding(false); setReason(""); void qc.invalidateQueries({ queryKey: ["assignment-checks"] }); },
  });
  if (!enabled) return null;
  if (q.isLoading) return <p className="text-sm text-slate-500" role="status">Checking…</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-sm text-red-700">{actionError(q.error, "The checks could not be run.")}</p>;
  const ev = q.data;
  const availability = groupOutcome(ev.checks, CHECK_GROUPS[0]!);
  const canOverride = availability.state === "blocked" && !!input?.clientId && hasPermission("availability.override");
  return (
    <section aria-label="Assignment checks" className="space-y-2 rounded-lg border border-slate-200 bg-og-card p-3">
      <ul className="space-y-2">
        {CHECK_GROUPS.map((g) => {
          const o = groupOutcome(ev.checks, g);
          const tone = o.state === "blocked" ? "text-red-800" : o.state === "would_block" ? "text-amber-900" : "text-slate-800";
          return (
            <li key={g.key} className="text-sm">
              <span className="font-medium text-slate-900">{g.title}: </span>
              {o.state === "ok" || o.state === "not_checked" ? <span className={tone}>{STATE_TEXT[o.state]}</span> : (
                <span className={tone}>
                  {o.messages.join(" ")}
                  {o.state === "would_block" ? <span className="block text-xs text-slate-600">{g.key === "documents" ? "Report-only: this does NOT meet the requirement for current, verified CPR and TB. It will block assignment and new visits once readiness checks are activated." : `Not blocking yet. This will be required after readiness checks are activated${g.key === "service" ? " and Service checks are On" : ""}.`}</span> : null}
                  {o.state === "overridden" ? <span className="block text-xs text-slate-600">Approved by an administrator for this assignment only.</span> : null}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {ev.ready ? <p className={`text-sm font-semibold ${ev.wouldBlockAfterActivation ? "text-amber-950" : "text-emerald-900"}`} role="status">{ev.wouldBlockAfterActivation ? "Assignment allowed with unenforced checks. Review the warnings above." : "Ready to assign"}</p> : <p className="text-sm font-semibold text-red-800" role="status">Cannot be assigned yet</p>}
      {canOverride ? (
        overriding ? (
          <div role="group" className="space-y-2" aria-label="Override availability">
            <label className="block text-sm font-medium text-slate-800">Reason for the override
              <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base" />
            </label>
            <ShortHelp className="text-xs text-slate-600" details="It does not change the caregiver's recorded availability, service approval, documents or bookings. To change their ongoing availability, use Edit Availability.">One-time override of the availability check for this caregiver, this client and this one shift. It can be used once, within 30 minutes.</ShortHelp>
            {override.isError ? <p role="alert" className="text-sm text-red-700">{actionError(override.error, "The override could not be saved.")}</p> : null}
            <Button type="button" variant="secondary" disabled={override.isPending || reason.trim().length < 3} onClick={() => override.mutate()}>{override.isPending ? "Saving…" : "Override availability"}</Button>
          </div>
        ) : <Button type="button" variant="secondary" onClick={() => setOverriding(true)}>Override availability…</Button>
      ) : null}
    </section>
  );
}
