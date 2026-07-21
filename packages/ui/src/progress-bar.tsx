import { cn } from "./cn";
import { StatusBadge, type StatusTone } from "./status-badge";

// Used for anything measured against a limit: authorized hours used
// this month, caregiver utilization this week. The bar alone is never
// the only thing shown - callers are expected to also render the raw
// numbers as text (see caregiver-detail-page.tsx's existing "20h / 15h"
// pattern) since a bar with no numbers next to it can't answer "used
// vs. remaining" precisely, only roughly.
export interface ProgressBarProps {
  value: number;
  max: number;
  tone?: StatusTone;
  label?: string;
  className?: string;
}

export function ProgressBar({ value, max, tone = "info", label, className }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const barTone: Record<StatusTone, string> = {
    neutral: "bg-slate-400",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    info: "bg-sky-500"
  };

  return (
    <div className={className}>
      {label ? <p className="mb-1 text-xs text-slate-500">{label}</p> : null}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={cn("h-full rounded-full transition-all", barTone[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Shared thresholds for "usage against a limit" bars (authorized hours,
 * caregiver utilization). Kept as one function so the definition of
 * "approaching" vs "over" can't drift between the client authorization
 * view and the caregiver capacity view.
 */
export function usageTone(value: number, max: number): StatusTone {
  if (max <= 0) return "neutral";
  const pct = value / max;
  if (pct > 1) return "danger";
  if (pct >= 0.9) return "warning";
  return "success";
}

export function usageLabel(value: number, max: number): string {
  if (max <= 0) return "No limit set";
  const pct = value / max;
  if (pct > 1) return "Over limit";
  if (pct >= 0.9) return "Approaching limit";
  return "Normal usage";
}

export interface UsageBadgeProps {
  value: number;
  max: number;
  className?: string;
}

export function UsageBadge({ value, max, className }: UsageBadgeProps) {
  return <StatusBadge label={usageLabel(value, max)} tone={usageTone(value, max)} className={className} />;
}
