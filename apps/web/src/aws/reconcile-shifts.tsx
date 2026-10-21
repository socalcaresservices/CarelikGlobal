import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { Hint } from "./hint";
import { nameWithCode } from "./name-label";
import { useShiftsToReconcile, type ShiftToReconcile } from "./reconcile-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

type Outcome = "no_service_delivered" | "hold_service_may_have_occurred" | "delivered_unverified";

const CHOICES: Array<{ outcome: Outcome; label: string; effect: string; noteLabel: string }> = [
  { outcome: "no_service_delivered", label: "No service was delivered", effect: "Releases the reserved authorization time.", noteLabel: "What did you check to confirm no service was delivered?" },
  { outcome: "delivered_unverified", label: "It was delivered, but there is no verified visit", effect: "The time stays reserved and counted. Nothing is billable and no visit is created.", noteLabel: "Who says it was delivered, and what is missing?" },
  { outcome: "hold_service_may_have_occurred", label: "I cannot confirm yet", effect: "The time stays reserved and counted until you decide.", noteLabel: "What is still to be checked?" },
];

/**
 * Shifts that ended with no visit record: one concise row each, with the decision as a choice plus one Save. Nothing is released automatically: a missing visit does not prove nothing happened.
 * "No service was delivered" releases the reserved time; "I cannot confirm yet" keeps it reserved and counted. The page shows the heading and count.
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
  const list = useShiftsToReconcile();
  async function save(s: ShiftToReconcile, outcome: Outcome) {
    if (busy) return;
    if (note.trim().length < 10) return setError({ id: s.shiftId, text: "Note too short. Write a sentence saying what you checked." });
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
      setError({ id: s.shiftId, text: message(cause, "Not saved. Nothing was released. Try again.") });
    } finally {
      setBusy(null);
      await Promise.all(["aws-reconcile", "attention-overview", "aws-utilisation", "aws-shifts", "monthly-chain"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    }
  }
  if (!canManage || !list.data || list.data.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="shifts-to-reconcile">
      <Hint details="This authorization time is still reserved and counted. Nothing is released automatically: a missing visit record does not prove no one came. Check, then record what you found.">These shifts ended with no visit record. Choose what you found and save.</Hint>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-og-card">
        {list.data.map((s) => {
          const choices = CHOICES.filter((c) => (c.outcome !== "delivered_unverified" || s.lastOutcome !== "delivered_unverified") && (c.outcome !== "hold_service_may_have_occurred" || s.bucket === "unreconciled"));
          const mine = open?.id === s.shiftId ? CHOICES.find((c) => c.outcome === open.outcome) : undefined;
          return (
            <li key={s.shiftId} className="p-2 text-sm">
              <details>
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 md:min-h-9">
                  <span className="font-semibold text-slate-950">{when(s.startsAt)}–{time(s.endsAt)}</span>
                  <span className="text-slate-800">{s.clientName ? nameWithCode(s.clientName, s.clientCode, s.duplicateName) : `Client ${s.clientCode ?? "?"}`}{s.serviceName ? ` · ${s.serviceName}` : ""} · {s.caregiverCode ? (s.caregiverName ? nameWithCode(s.caregiverName, s.caregiverCode, s.caregiverDuplicateName) : `Caregiver ${s.caregiverCode}`) : "No caregiver"} · {formatDuration(s.reservedMinutes)} reserved</span>
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Ended {s.endedHours < 1 ? "<1 hr" : `${s.endedHours} hr`} ago</span>
                  <span className="ml-auto text-sm font-medium text-og-link underline underline-offset-2">Record what happened</span>
                </summary>
                {s.bucket === "awaiting_record" ? (
                  <p className="mt-1 text-amber-900" data-testid="awaiting-note">
                    {s.lastOutcome === "delivered_unverified" ? "Delivered — not verified" : "Awaiting a record"}: “{s.lastNote}”. Still reserved and counted. Not billable, and no visit exists.
                  </p>
                ) : null}
                <fieldset className="mt-2 space-y-1">
                  <legend className="text-xs font-medium text-slate-700">What did you find?</legend>
                  {choices.map((c) => (
                    <label key={c.outcome} className="flex min-h-11 items-center gap-2 text-slate-900 md:min-h-8">
                      <input type="radio" name={`rc-${s.shiftId}`} checked={open?.id === s.shiftId && open.outcome === c.outcome} disabled={busy !== null}
                        onChange={() => { if (open?.id !== s.shiftId) setNote(""); setOpen({ id: s.shiftId, outcome: c.outcome }); setError(null); }} />
                      {c.label}
                    </label>
                  ))}
                </fieldset>
                {mine ? (
                  <div className="mt-1 space-y-2">
                    <p className="text-xs text-slate-700">{mine.effect}</p>
                    <label className="block text-xs font-medium text-slate-600">
                      {mine.noteLabel}
                      <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
                    </label>
                  </div>
                ) : null}
                {error?.id === s.shiftId ? <p role="alert" className="mt-1 text-red-700">{error.text}</p> : null}
                <div className="mt-2">
                  <Button type="button" className="min-h-11" disabled={busy !== null || !mine} loading={busy === s.shiftId} onClick={() => open && void save(s, open.outcome)}>Save</Button>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
