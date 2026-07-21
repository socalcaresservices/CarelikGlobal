import type { ReactNode } from "react";
import { Card } from "./card";
import { cn } from "./cn";

// The "big number + short label" card used across Overview's "This
// week" row and the Agency health row - previously hand-written inline
// per card in overview-page.tsx.
//
// Deliberately router-agnostic: this package doesn't depend on
// react-router-dom, so it doesn't render its own link. Every dashboard
// metric is supposed to link to the filtered records behind it (e.g.
// "3 expiring credentials" -> the Credentials page) - to do that, wrap
// the card in the app's own `<Link to="...">` rather than passing an
// `href` here, so navigation stays client-side instead of reloading.
export interface MetricCardProps {
  value: ReactNode;
  label: string;
  hint?: string;
  linkable?: boolean;
  className?: string;
}

export function MetricCard({ value, label, hint, linkable, className }: MetricCardProps) {
  return (
    <Card className={cn(linkable ? "transition hover:border-slate-300 hover:shadow-md" : undefined, className)}>
      <p className="text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-sm text-slate-600">
        {label}
        {hint ? <span className="ml-1 text-xs text-slate-400">{hint}</span> : null}
      </p>
    </Card>
  );
}
