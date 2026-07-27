import type { ReactNode } from "react";
import { Card } from "./card";
import { cn } from "./cn";
import { StatusChip } from "./status-chip";
import type { StatusTone } from "./status-badge";

// The "icon, tone dot + status word, big number, label" tile
// action-center.tsx was hand-writing per signal (see that file's
// previous inline `<Link className="rounded-2xl border ...">` block).
// Deliberately router-agnostic like MetricCard - this package doesn't
// depend on react-router-dom, so wrap this in the app's own `<Link
// className="block">` for navigation rather than passing an `href`
// here; `linkable` only adds the hover affordance classes.
export interface AlertCardProps {
  icon?: ReactNode;
  value: ReactNode;
  label: string;
  statusText: string;
  tone: StatusTone;
  linkable?: boolean;
  className?: string;
}

export function AlertCard({ icon, value, label, statusText, tone, linkable, className }: AlertCardProps) {
  return (
    <Card className={cn(linkable ? "transition hover:border-slate-300 hover:shadow-md" : undefined, className)}>
      <div className="flex items-center justify-between">
        {icon ? <span className="text-slate-400">{icon}</span> : <span aria-hidden="true" />}
        <StatusChip label={statusText} tone={tone} />
      </div>
      <p className="mt-4 text-metric tabular-nums text-slate-950">{value}</p>
      <p className="mt-1 text-body text-slate-600">{label}</p>
    </Card>
  );
}
