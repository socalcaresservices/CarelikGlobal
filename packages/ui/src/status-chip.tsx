import type { ReactNode } from "react";
import { cn } from "./cn";
import { toneTextClasses, type StatusTone } from "./status-badge";

// A second status-indicator shape alongside StatusBadge's solid pill:
// a small tone-colored dot plus text, no background. This is exactly
// the pattern action-center.tsx was hand-writing per signal card
// ("● Review" / "● All caught up") - formalized here so any future
// dashboard-style status line reuses it instead of re-deriving the dot
// classes. Named presets cover the workflow states that repeat across
// the app (credential/authorization/membership/shift status words);
// pass `label`/`tone` directly for anything not in the list.
export type StatusChipPreset =
  | "active"
  | "inactive"
  | "pending"
  | "expiring"
  | "expired"
  | "verified"
  | "scheduled"
  | "completed"
  | "cancelled"
  | "atRisk"
  | "available";

const presetConfig: Record<StatusChipPreset, { label: string; tone: StatusTone }> = {
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  pending: { label: "Pending", tone: "warning" },
  expiring: { label: "Expiring soon", tone: "warning" },
  expired: { label: "Expired", tone: "danger" },
  verified: { label: "Verified", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  atRisk: { label: "At risk", tone: "danger" },
  available: { label: "Available", tone: "success" }
};

const dotToneClasses: Record<StatusTone, string> = {
  neutral: "bg-slate-400",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-sky-500"
};

export interface StatusChipProps {
  /** One of the named workflow presets. Ignored if `label`/`tone` are given. */
  status?: StatusChipPreset;
  label?: string;
  tone?: StatusTone;
  icon?: ReactNode;
  className?: string;
}

export function StatusChip({ status, label, tone, icon, className }: StatusChipProps) {
  const resolved = label !== undefined && tone !== undefined
    ? { label, tone }
    : status
      ? presetConfig[status]
      : { label: label ?? "Unknown", tone: tone ?? "neutral" };

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", toneTextClasses[resolved.tone], className)}>
      {icon ?? <span className={cn("h-1.5 w-1.5 rounded-full", dotToneClasses[resolved.tone])} aria-hidden="true" />}
      {resolved.label}
    </span>
  );
}
