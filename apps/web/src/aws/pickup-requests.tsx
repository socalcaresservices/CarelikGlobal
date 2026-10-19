import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { ShortHelp } from "./help-text";
import { clientLabel } from "./name-label";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** 0063: a caregiver's request for an open shift. Nothing is assigned until this person confirms; the server re-checks everything at that moment. */
export interface PickupRequest {
  requestId: string; shiftId: string; requestedAt: string; startsAt: string; endsAt: string; minutes: number; clientCode: string; clientName?: string | null; duplicateName?: boolean; serviceName: string | null;
  caregiverRecordId: string; caregiverCode: string; caregiverName: string | null; blockers: string[];
}

export function PickupRequestsPanel({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { when, time } = useAgencyClock();
  const canManage = hasPermission("shifts.manage");
  const [declining, setDeclining] = useState<string | null>(null);
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
        queryClient.invalidateQueries({ queryKey: ["aws-shifts"] }),
        queryClient.invalidateQueries({ queryKey: ["attention-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["aws-open-shifts"] }),
      ]);
    }
  }
  if (!canManage || !list.data || list.data.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="pickup-requests" aria-labelledby="pickup-heading">
      <h2 id="pickup-heading" className="text-base font-semibold text-slate-950">Caregiver requests for open shifts ({list.data.length})</h2>
      <ShortHelp details="Confirming checks the shift again: compliance, availability, other shifts, hour limits and the authorization.">Nobody is assigned until you confirm.</ShortHelp>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-og-card">
        {list.data.map((r) => (
          <li key={r.requestId} className="p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="font-semibold text-slate-950">{when(r.startsAt)}–{time(r.endsAt)} · {clientLabel(r, true)}{r.serviceName ? ` · ${r.serviceName}` : ""} · {formatDuration(r.minutes)}</p>
                <p className="text-slate-800">Asked by {r.caregiverName ?? r.caregiverCode} ({r.caregiverCode})</p>
              </div>
              {declining !== r.requestId ? (
                <div className="flex items-center gap-3">
                  <Button type="button" className="min-h-11" disabled={busy !== null} loading={busy === r.requestId} onClick={() => void act(r, "confirm")}>Confirm assignment</Button>
                  <button type="button" className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-og-link underline underline-offset-2 disabled:text-slate-500 disabled:no-underline" disabled={busy !== null} onClick={() => { setDeclining(r.requestId); setReason(""); setError(null); }}>Decline</button>
                </div>
              ) : null}
            </div>
            {r.blockers.length > 0 ? (
              <p role="note" className="mt-1 text-red-800">Would be refused now: {r.blockers.join(" ")}</p>
            ) : (
              <p className="mt-1 text-emerald-800">No problem found right now.</p>
            )}
            {error?.id === r.requestId ? <p role="alert" className="mt-1 text-red-700">{error.text}</p> : null}
            {declining === r.requestId ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-slate-600">
                  Reason for declining
                  <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-64 max-w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
                </label>
                <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} loading={busy === r.requestId} onClick={() => void act(r, "decline")}>Decline request</Button>
                <button type="button" className="inline-flex min-h-11 items-center text-sm underline" onClick={() => { setDeclining(null); setError(null); }}>Cancel</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
