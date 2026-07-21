import { Card } from "./card";
import { ProgressBar, usageTone } from "./progress-bar";

// Compact "available / scheduled / remaining" summary for a caregiver's
// weekly capacity - used on both the caregiver detail page (full) and,
// in its compact form, per-row on the Team list. Every number the
// caregiver-capacity spec asks for is rendered as plain text next to
// the bar, not folded into the bar alone, so nothing here is a chart
// standing in for a number nobody can read precisely.
export interface UtilizationCardProps {
  availableHours: number | null;
  scheduledHours: number;
  completedHours?: number;
  compact?: boolean;
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function UtilizationCard({
  availableHours,
  scheduledHours,
  completedHours,
  compact
}: UtilizationCardProps) {
  const hasTarget = availableHours != null && availableHours > 0;
  const remaining = hasTarget ? Math.max(0, availableHours! - scheduledHours) : null;
  const utilizationPct = hasTarget ? Math.round((scheduledHours / availableHours!) * 100) : null;
  const tone = hasTarget ? usageTone(scheduledHours, availableHours!) : "neutral";

  const body = (
    <>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Available</p>
          <p className="mt-0.5 font-semibold text-slate-950">{hasTarget ? `${formatHours(availableHours!)}h` : "Not set"}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Scheduled</p>
          <p className="mt-0.5 font-semibold text-slate-950">{formatHours(scheduledHours)}h</p>
        </div>
        {completedHours != null ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Completed</p>
            <p className="mt-0.5 font-semibold text-slate-950">{formatHours(completedHours)}h</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Remaining</p>
          <p className="mt-0.5 font-semibold text-slate-950">{remaining != null ? `${formatHours(remaining)}h` : "—"}</p>
        </div>
      </div>
      {hasTarget ? (
        <ProgressBar
          value={scheduledHours}
          max={availableHours!}
          tone={tone}
          label={`${utilizationPct}% utilized`}
          className="mt-3"
        />
      ) : null}
    </>
  );

  if (compact) return <div>{body}</div>;

  return <Card>{body}</Card>;
}
