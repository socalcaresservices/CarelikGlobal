import type { ReactNode } from "react";

/** Title, one plain sentence, and the page's primary action. Longer explanations go behind a Disclosure. */
export function PageHeader({ title, lead, action }: { title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-og-ink">{title}</h1>
        {lead ? <p className="mt-0.5 text-sm text-og-sub">{lead}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
