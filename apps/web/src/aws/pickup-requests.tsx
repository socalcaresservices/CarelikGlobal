import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { Hint } from "./hint";
import { clientLabel } from "./name-label";
import { refreshAfterShiftChange } from "./shift-refresh";
import { schedulingRefusal } from "./scheduling-refusal";
import { pacific } from "./pacific-time";

const message = schedulingRefusal;

/** 0063: a caregiver's request for an open shift. Nothing is assigned until this person confirms; the server re-checks everything at that moment. */
export interface PickupRequest {
  requestId: string; shiftId: string; requestedAt: string; startsAt: string; endsAt: string; minutes: number; clientCode: string; clientName?: string | null; duplicateName?: boolean; serviceName: string | null;
  caregiverRecordId: string; caregiverCode: string; caregiverName: string | null; blockers: string[]; eligible?: boolean; requestRank?: number;
}

export function PickupRequestsPanel({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { when, time } = useAgencyClock();
  const canManage = hasPermission("shifts.manage");
  const [declining, setDeclining] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  // One key per request and action, so a double tap or a retry is the same decision.
  const keys = useRef(new Map<string, string>());
  const keyFor = (k: string) => { if (!keys.current.has(k)) keys.current.set(k, newIdempotencyKey()); return keys.current.get(k)!; };
  const list = useQuery({
    queryKey: ["aws-pickups", activeOrganizationId],
    queryFn: async () => (await api.get<{ requests: PickupRequest[] }>("/v1/shift-pickups", { organizationId: activeOrganizationId })).requests,
    enabled: !!activeOrganizationId && canManage,
  });
  async function act(r: PickupRequest, kind: "confirm" | "decline") {
    if (busy) return;
    if (kind === "decline" && reason.trim().length < 3) return setError({ id: r.requestId, text: "Reason missing. Say why you are declining." });
    setBusy(r.requestId);
    setError(null);
    try {
      await api.post(`/v1/shift-pickups/${encodeURIComponent(r.requestId)}/${kind}`,
        { organizationId: activeOrganizationId, ...(kind === "decline" ? { reason: reason.trim() } : {}) }, { idempotencyKey: keyFor(`${kind}:${r.requestId}`) });
      keys.current.delete(`${kind}:${r.requestId}`);
      setDeclining(null);
      setReason("");
      onDone(kind === "confirm" ? `${r.caregiverName ?? r.caregiverCode} is now assigned to the shift. The other requests for it were closed.` : "Request declined. The shift is still open.");
    } catch (cause) {
      keys.current.delete(`${kind}:${r.requestId}`);
      setError({ id: r.requestId, text: message(cause, kind === "confirm" ? "Not confirmed. Nothing was assigned." : "Not declined.") });
    } finally {
      setBusy(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["aws-pickups"] }),
        refreshAfterShiftChange(queryClient),
      ]);
    }
  }
  if (!canManage || !list.data || list.data.length === 0) return null;
  // One card per shift. Within a shift the requests are in the order they were made (first asked first). The EARLIEST ELIGIBLE request is preselected;
  // someone who asked earlier but cannot be confirmed stays in their place, with the reason.
  const isEligible = (r: PickupRequest) => r.eligible ?? r.blockers.length === 0;
  const groups = new Map<string, PickupRequest[]>();
  for (const r of list.data) groups.set(r.shiftId, [...(groups.get(r.shiftId) ?? []), r]);
  const ordered = [...groups.values()].map((g) => [...g].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)));
  return (
    <section className="space-y-2" data-testid="pickup-requests" aria-labelledby="pickup-heading">
      <h2 id="pickup-heading" className="text-base font-semibold text-slate-950">Caregiver requests for open shifts ({list.data.length})</h2>
      <Hint details="Confirming checks the shift again: compliance, availability, other shifts, hour limits and the authorization. Only the office confirms." show>Nobody is assigned until you confirm.</Hint>
      <ul className="space-y-2">
        {ordered.map((g) => {
          const first = g[0]!; const defaultId = g.find(isEligible)?.requestId ?? null;
          const chosenId = chosen[first.shiftId] ?? defaultId;
          const sel = g.find((r) => r.requestId === chosenId) ?? null;
          return (
            <li key={first.shiftId} className="rounded-lg border border-slate-200 bg-og-card p-2 text-sm" data-testid="pickup-shift">
              <p className="font-semibold text-slate-950" data-testid="pickup-start">Shift starts {pacific(first.startsAt)}</p>
              <p className="font-semibold text-slate-950">{when(first.startsAt)}–{time(first.endsAt)} · {clientLabel(first, true)}{first.serviceName ? ` · ${first.serviceName}` : ""} · {formatDuration(first.minutes)}</p>
              <fieldset className="mt-1">
                <legend className="sr-only">Choose who to confirm for this shift</legend>
                <ul className="space-y-1">
                  {g.map((r, i) => (
                    <li key={r.requestId} className="rounded border border-slate-100 p-1.5">
                      <label className="flex min-h-11 items-start gap-2">
                        <input type="radio" name={`pick-${first.shiftId}`} className="mt-1" checked={chosenId === r.requestId} disabled={busy !== null} onChange={() => setChosen((c) => ({ ...c, [first.shiftId]: r.requestId }))} data-testid="pickup-choice" />
                        <span className="min-w-0">
                          <span className="font-medium text-slate-950">{i + 1}. {r.caregiverName ?? r.caregiverCode} ({r.caregiverCode})</span>
                          <span className="block text-slate-700" data-testid="pickup-asked">Asked {pacific(r.requestedAt)}</span>
                          {r.requestId === defaultId ? <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900" data-testid="pickup-earliest">Earliest eligible request</span> : null}
                          {r.blockers.length > 0 ? <span role="note" className="block text-red-800">Would be refused now: {r.blockers.join(" ")}</span> : <span className="block text-emerald-800">No problem found right now.</span>}
                        </span>
                      </label>
                      {error?.id === r.requestId ? <p role="alert" className="mt-1 text-red-700">{error.text}</p> : null}
                    </li>
                  ))}
                </ul>
              </fieldset>
              {sel && declining !== sel.requestId ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button type="button" className="min-h-11" disabled={busy !== null} loading={busy === sel.requestId} onClick={() => void act(sel, "confirm")}>Confirm assignment</Button>
                  <button type="button" className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-og-link underline underline-offset-2 disabled:text-slate-500 disabled:no-underline" disabled={busy !== null} onClick={() => { setDeclining(sel.requestId); setError(null); }}>Decline this request</button>
                </div>
              ) : null}
              {!sel ? <p className="mt-1 text-slate-700">Nobody asking can be confirmed right now. Choose someone to see what blocks them.</p> : null}
              {sel && declining === sel.requestId ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="text-xs font-medium text-slate-600">
                    Reason for declining
                    <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-64 max-w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
                  </label>
                  <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} loading={busy === sel.requestId} onClick={() => void act(sel, "decline")}>Decline request</Button>
                  <button type="button" className="inline-flex min-h-11 items-center text-sm underline" onClick={() => { setDeclining(null); setError(null); }}>Cancel</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
