import type { ReactNode } from "react";
import { Card } from "./card";
import { cn } from "./cn";
import { toneTextClasses, type StatusTone } from "./status-badge";

// A single compact row of KPIs sharing one Card, for the "desired /
// scheduled / remaining / gap"-style band docs/design-system.md's
// "Capacity first" and record-layout sections describe - distinct from
// MetricCard, which is one number per Card for a grid layout (Command
// Center's OperationalSnapshot used a 6-up grid of MetricCards; this is
// the same numbers as one denser band instead).
export interface MetricStripItem {
  key: string;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: StatusTone;
}

export interface MetricStripProps {
  items: MetricStripItem[];
  className?: string;
}

export function MetricStrip({ items, className }: MetricStripProps) {
  return (
    <Card className={cn("flex flex-wrap gap-y-4 divide-x divide-slate-100 p-0", className)}>
      {items.map((item) => (
        <div key={item.key} className="min-w-[8rem] flex-1 px-5 py-4 first:pl-5">
          <p className="text-caption font-medium uppercase tracking-wide text-slate-500">{item.label}</p>
          <p className={cn("mt-1 text-metric tabular-nums", item.tone ? toneTextClasses[item.tone] : "text-slate-950")}>
            {item.value}
          </p>
          {item.hint ? <p className="mt-0.5 text-caption text-slate-400">{item.hint}</p> : null}
        </div>
      ))}
    </Card>
  );
}
