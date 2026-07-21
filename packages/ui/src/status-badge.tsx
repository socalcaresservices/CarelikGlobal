import { cn } from "./cn";

// Every status pill in this app (membership status, credential status,
// authorization status, shift status...) was previously a one-off
// `Record<Status, string>` className map hand-written per page (see
// team-page.tsx's statusStyles). This centralizes the same five tones
// so new status pills (authorization "over limit", credential
// "expiring soon") stay visually consistent without re-deriving colors.
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<StatusTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  info: "bg-sky-50 text-sky-700"
};

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  className?: string | undefined;
}

export function StatusBadge({ label, tone = "neutral", className }: StatusBadgeProps) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", toneClasses[tone], className)}>
      {label}
    </span>
  );
}
