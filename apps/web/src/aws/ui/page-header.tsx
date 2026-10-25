import type { ReactNode } from "react";
import { InfoTip } from "./info-tip";

/** Title and the page's primary action. The one-sentence lead sits behind an info icon next to the title (it stays in the page for screen readers). */
export function PageHeader({ title, lead, action }: { title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="text-xl font-bold tracking-tight text-og-ink">{title}</h1>
        {lead ? <InfoTip label={`About ${title}`} title={title}>{lead}</InfoTip> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
