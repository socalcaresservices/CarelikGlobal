// Details for ONE authorization: the hours-accounting equation with every bucket visible (migration 0079). Display only; the server did the arithmetic.
import { HOURS_DEFINITIONS, HOURS_EQUATION_TEXT, HOURS_NAMES, hasHours, hoursEquation, type HoursFields } from "@/lib/hours-accounting";
import { formatDuration } from "@/lib/service-verification";

export function HoursBreakdown({ row, label = "Details" }: { row: HoursFields; label?: string }) {
  if (!hasHours(row)) return null;
  const lines = hoursEquation(row);
  const worked = Number(row.hoursWorkedNotBillableMinutes ?? 0);
  const closedHeld = Number(row.hoursClosedNotBillableHeldMinutes ?? 0);
  const closedWorked = Number(row.hoursClosedNotBillableWorkedMinutes ?? 0);
  const pending = {
    review: Number(row.hoursPendingReviewMinutes ?? 0),
    held: Number(row.hoursPendingHeldMinutes ?? 0),
    unreserved: Number(row.hoursPendingUnreservedMinutes ?? 0),
  };
  return (
    <details className="mt-2 text-xs text-slate-700" data-testid="hours-breakdown">
      <summary className="inline-flex min-h-[32px] cursor-pointer items-center font-semibold underline">{label}</summary>
      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
        {lines.map((l) => (
          <div key={l.key} className="contents">
            <dt className={l.tone === "red" ? "font-semibold text-red-700" : ""}>{l.label}{l.note ? <span className="font-normal text-slate-500"> ({l.note})</span> : null}</dt>
            <dd className={`text-right ${l.tone === "red" ? "font-semibold text-red-700" : ""}`}>{formatDuration(l.minutes)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1">{HOURS_EQUATION_TEXT}</p>
      {pending.review + pending.held + pending.unreserved > 0 ? (
        <p className="mt-1">{HOURS_NAMES.pending} is {[
          pending.review ? `${formatDuration(pending.review)} counted on visits in review` : null,
          pending.held ? `${formatDuration(pending.held)} of shift time held for a visit awaiting confirmation or review` : null,
          pending.unreserved ? `${formatDuration(pending.unreserved)} worked on visits with no scheduled shift, awaiting confirmation or review` : null,
        ].filter(Boolean).join(", ")}.</p>
      ) : null}
      {closedHeld > 0 ? <p className="mt-1" data-testid="closed-not-billable">Closed, not billable: {formatDuration(closedHeld)} of shift time is still held inside {HOURS_NAMES.reserved}{closedWorked > 0 ? `; ${formatDuration(closedWorked)} worked is kept on record` : ""}. It stays held until a person decides whether to release it.</p> : null}
      {worked > 0 ? <p className="mt-1 font-semibold text-amber-900" data-testid="worked-not-billable">{HOURS_NAMES.workedNotBillable}: {formatDuration(worked)}. {HOURS_DEFINITIONS.workedNotBillable}</p> : null}
    </details>
  );
}
