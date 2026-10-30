import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { DocumentRuleHint } from "./document-rule-hint";
import { CHECK_GROUPS, actionError, groupOutcome, type CheckRow } from "./format";
import { InfoTip } from "../ui/info-tip";


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

/** `outcome` and `summary` are the server's single eligibility decision, computed from the same rows as `checks`. The screen never derives them. */
interface Evaluation { startsAt: string; endsAt: string; ready: boolean; wouldBlockAfterActivation: boolean; outcome: "allowed" | "warning" | "blocked"; summary: string; checks: CheckRow[] }

/** The four checks, plus hours: the server can refuse on the hour limits, and that refusal must be named, not summarized as "a required check". */
const GROUPS = [...CHECK_GROUPS, { key: "hours", title: "Hours and limits", checks: ["hours"] }];

const STATE_TEXT = { ok: "OK", blocked: "", would_block: "", overridden: "", not_checked: "Not checked" } as const;

/** The overall result is the server's own words ('Allowed', 'Warning: ...', 'Blocked: ...'); only the colour is chosen here. */
function checksOutcome(ev: Evaluation): { tone: "ok" | "warn" | "bad"; text: string } {
  return { tone: ev.outcome === "blocked" ? "bad" : ev.outcome === "warning" ? "warn" : "ok", text: ev.summary };
}
const OUTCOME_TONE = { ok: "text-emerald-900", warn: "text-amber-950", bad: "text-red-800" } as const;

/**
 * The four separate checks before a caregiver is committed: Availability, Approved services, Documents, Conflicts.
 * One outcome line comes first; a failing or warning check is listed under it in the server's exact words, and the full list sits behind Details.
 * `outcome` (a refusal from the server) replaces the headline; the caregiver-check result then becomes supporting text. `note` is a short fixed line under the outcome.
 * The parent is told (onReady) so it can keep a blocked caregiver from being assigned.
 */
export function AssignmentChecks({ input, onReady, outcome, note }: { input: AssignmentCheckInput | null; onReady?: (ready: boolean | null) => void; outcome?: ReactNode; note?: string }) {
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
  const result = checksOutcome(ev);
  const rows = GROUPS.map((g) => ({ g, o: groupOutcome(ev.checks, g) }));
  const shown = rows.filter(({ o }) => o.state !== "ok" && o.state !== "not_checked");
  const row = ({ g, o }: (typeof rows)[number]) => {
    const tone = o.state === "blocked" ? "text-red-800" : o.state === "would_block" ? "text-amber-900" : "text-slate-800";
    return (
      <li key={g.key} className="text-sm">
        <span className="font-medium text-slate-900">{g.title}: </span>
        {o.state === "ok" || o.state === "not_checked" ? <span className={tone}>{STATE_TEXT[o.state]}</span> : (
          <span className={tone}>
            {o.messages.join(" ")}
            {g.key === "documents" ? ev.checks.filter((c) => (c.check === "cpr" || c.check === "tb") && c.status === "blocked" && (c.code === "missing" || c.code === "type_not_set" || c.code === "policy_not_set")).map((c) => <DocumentRuleHint key={c.check} requirement={c.check as "cpr" | "tb"} />) : null}
            {o.state === "would_block" && ev.outcome === "warning" ? <span className="block text-xs text-slate-600">{g.key === "documents" ? "Report-only: this does NOT meet the requirement for current, verified CPR and TB." : "Not blocking yet."}</span> : null}
            {o.state === "overridden" ? <span className="block text-xs text-slate-600">Approved by an administrator for this assignment only.</span> : null}
          </span>
        )}
      </li>
    );
  };
  return (
    <section aria-label="Assignment checks" className="space-y-1 rounded-md border border-slate-200 bg-og-card px-2 py-1.5">
      {outcome ? <div role="alert" data-testid="assignment-outcome" className="text-sm font-semibold text-red-800">{outcome}</div> : <p role="status" data-testid="assignment-outcome" className={`text-sm font-semibold ${OUTCOME_TONE[result.tone]}`}>{result.text}</p>}
      {outcome ? <p className={`text-xs ${OUTCOME_TONE[result.tone]}`}>{result.text}</p> : note ? <p className="text-xs text-slate-600">{note}</p> : null}
      {shown.length > 0 ? <ul className="space-y-1">{shown.map(row)}</ul> : null}
      <details>
        <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-sm text-og-accent underline">Details</summary>
        <ul className="mt-1 space-y-1">{rows.filter((r) => !shown.includes(r)).map(row)}</ul>
        {ev.outcome === "warning" && ev.wouldBlockAfterActivation ? <p className="mt-1 text-xs text-slate-600">Warnings do not block today. They will block assignment and new visits once readiness checks are activated{rows.some((r) => r.g.key === "service" && r.o.state === "would_block") ? " and Service checks are On" : ""}.</p> : null}
      </details>
      {canOverride ? (
        overriding ? (
          <div role="group" className="space-y-2" aria-label="Override availability">
            <label className="block text-sm font-medium text-slate-800">Reason for the override
              <textarea value={reason} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className="mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
            </label>
            <p className="flex items-center gap-1.5 text-xs text-slate-600">One-time override of the availability check for this caregiver, this client and this one shift. It can be used once, within 30 minutes.<InfoTip>It does not change the caregiver's recorded availability, service approval, documents or bookings. To change their ongoing availability, use Edit Availability.</InfoTip></p>
            {override.isError ? <p role="alert" className="text-sm text-red-700">{actionError(override.error, "The override could not be saved.")}</p> : null}
            <Button type="button" variant="secondary" disabled={override.isPending || reason.trim().length < 3} onClick={() => override.mutate()}>{override.isPending ? "Saving…" : "Override availability"}</Button>
          </div>
        ) : <Button type="button" variant="secondary" onClick={() => setOverriding(true)}>Override availability…</Button>
      ) : null}
    </section>
  );
}
