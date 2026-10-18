import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** 0067: a shift that ended with no visit record and still holds authorization time. */
export interface ShiftToReconcile {
  shiftId: string; reservationId: string; startsAt: string; endsAt: string; localDate: string; clientCode: string | null; serviceCode: string | null; serviceName: string | null;
  caregiverCode: string | null; reservedMinutes: number; bucket: "unreconciled" | "awaiting_record"; endedHours: number;
  lastOutcome: "no_service_delivered" | "hold_service_may_have_occurred" | "delivered_unverified" | null; lastNote: string | null; lastDecidedAt: string | null;
}

type Outcome = "no_service_delivered" | "hold_service_may_have_occurred" | "delivered_unverified";

/**
 * Shifts that ended with no visit record. Nothing is released automatically: a missing visit does not prove nothing happened. A person records what they found.
 * "No service was delivered" releases the reserved time; "I cannot confirm yet" keeps it reserved and counted.
 */
export function ReconcileShiftsPanel({ onDone }: { onDone: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { when, time } = useAgencyClock();
  const canManage = hasPermission("shifts.manage");
  const [open, setOpen] = useState<{ id: string; outcome: Outcome } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  const keyFor = (k: string) => { if (!keys.current.has(k)) keys.current.set(k, newIdempotencyKey()); return keys.current.get(k)!; };
  const list = useQuery({
    queryKey: ["aws-reconcile", activeOrganizationId],
    queryFn: async () => (await api.get<{ shifts: ShiftToReconcile[] }>("/v1/shifts-to-reconcile", { organizationId: activeOrganizationId })).shifts,
    enabled: !!activeOrganizationId && canManage,
  });
  async function save(s: ShiftToReconcile, outcome: Outcome) {
    if (busy) return;
    if (note.trim().length < 10) return setError({ id: s.shiftId, text: "Write at least a short sentence saying what you checked." });
    setBusy(s.shiftId);
    setError(null);
    const key = `${s.shiftId}:${outcome}:${note.trim()}`;
    try {
      await api.post(`/v1/shifts/${encodeURIComponent(s.shiftId)}/reconcile`, { organizationId: activeOrganizationId, outcome, note: note.trim() }, { idempotencyKey: keyFor(key) });
      keys.current.delete(key);
      setOpen(null);
      setNote("");
      onDone(outcome === "no_service_delivered" ? `${formatDuration(s.reservedMinutes)} of authorization were released for that shift. Your note is on record.`
        : outcome === "delivered_unverified" ? "Recorded as delivered but not verified. The time stays reserved and counted, and nothing is billable. No visit was created." : "Kept as awaiting a record. The time stays reserved and counted until you decide.");
    } catch (cause) {
      keys.current.delete(key);
      setError({ id: s.shiftId, text: message(cause, "Not saved. Nothing was released.") });
    } finally {
      setBusy(null);
      await Promise.all(["aws-reconcile", "attention-overview", "aws-utilisation", "aws-shifts", "monthly-chain"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    }
  }
  if (!canManage || !list.data || list.data.length === 0) return null;
  return (
    <Card className="space-y-2 p-3" data-testid="shifts-to-reconcile">
      <h2 className="text-base font-semibold text-slate-950">Shifts that ended with no visit record ({list.data.length})</h2>
      <p className="text-sm text-slate-600">
        This authorization time is still reserved and counted. Nothing is released automatically: a missing visit record does not prove no one came. Check, then record what you found.
      </p>
      <ul className="space-y-2">
        {list.data.map((s) => (
          <li key={s.shiftId} className="rounded-xl border border-slate-200 bg-og-card p-3 text-sm">
            <p className="font-semibold text-slate-950">{when(s.startsAt)}–{time(s.endsAt)} · Client {s.clientCode ?? "?"}{s.serviceName ? ` · ${s.serviceName}` : ""} · {formatDuration(s.reservedMinutes)} reserved</p>
            <p className="text-slate-800">{s.caregiverCode ? `Caregiver ${s.caregiverCode}` : "No caregiver on the shift"} · ended {s.endedHours < 1 ? "less than an hour" : `${s.endedHours} hour${s.endedHours === 1 ? "" : "s"}`} ago</p>
            {s.bucket === "awaiting_record" ? (
              <p className="mt-1 text-amber-900" data-testid="awaiting-note">
                {s.lastOutcome === "delivered_unverified" ? "Delivered — not verified" : "Awaiting a record"}: “{s.lastNote}”. Still reserved and counted. Not billable, and no visit exists.
              </p>
            ) : null}
            {error?.id === s.shiftId ? <p role="alert" className="mt-1 text-red-700">{error.text}</p> : null}
            {open?.id === s.shiftId ? (
              <div className="mt-2 space-y-2">
                <label className="block text-xs font-medium text-slate-600">
                  {open.outcome === "no_service_delivered" ? "What did you check to confirm no service was delivered?" : open.outcome === "delivered_unverified" ? "Who says it was delivered, and what is missing?" : "What is still to be checked?"}
                  <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" className="min-h-11" disabled={busy !== null} loading={busy === s.shiftId} onClick={() => void save(s, open.outcome)}>
                    {open.outcome === "no_service_delivered" ? "Release the reserved time" : open.outcome === "delivered_unverified" ? "Record it as delivered, not verified" : "Keep it reserved"}
                  </Button>
                  <button type="button" className="min-h-11 text-sm underline" onClick={() => { setOpen(null); setError(null); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => { setOpen({ id: s.shiftId, outcome: "no_service_delivered" }); setNote(""); setError(null); }}>No service was delivered</Button>
                {s.lastOutcome !== "delivered_unverified" ? (
                  <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => { setOpen({ id: s.shiftId, outcome: "delivered_unverified" }); setNote(""); setError(null); }}>It was delivered, but there is no verified visit</Button>
                ) : null}
                {s.bucket === "unreconciled" ? (
                  <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => { setOpen({ id: s.shiftId, outcome: "hold_service_may_have_occurred" }); setNote(""); setError(null); }}>I cannot confirm yet</Button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
