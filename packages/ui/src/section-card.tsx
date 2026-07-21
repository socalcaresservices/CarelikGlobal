import type { ReactNode } from "react";
import { Card } from "./card";
import { cn } from "./cn";

// A Card with the "small heading + optional description + body" shape
// that shows up in every detail-page tab and form section (see
// caregiver-detail-page.tsx's Overview/Credentials/Schedule blocks).
// Compact by design - title and description share tight spacing so
// sections don't sprawl the way a full-width label-above-input form
// does. `dense` drops the Card's default padding for nested contexts
// (a section inside a section) so spacing doesn't compound.
export interface SectionCardProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
  className?: string;
}

export function SectionCard({ title, description, actions, children, dense, className }: SectionCardProps) {
  return (
    <Card className={cn(dense ? "p-4" : undefined, className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}
