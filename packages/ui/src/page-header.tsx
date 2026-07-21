import type { ReactNode } from "react";

// Every page in this app opens with the same "eyebrow label + big title"
// pattern, hand-written inline each time (see overview-page.tsx,
// team-page.tsx, clients-page.tsx, etc). Pulling it into one component
// stops that markup from drifting out of sync across pages, and gives
// every page a slot for header-level actions (e.g. an "Add" button)
// without each page inventing its own layout for that.
export interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-slate-500">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
