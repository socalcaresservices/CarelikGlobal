import type { ReactNode } from "react";
import { cn } from "@carelik/ui";

export interface AuditRow { id: string; when: string; who?: string | null; summary: string; detail?: ReactNode }

/**
 * History as one compact row per event: when, who, and one line of what (truncated). A row expands to the full detail. The list scrolls inside a fixed
 * height instead of growing the page.
 */
export function AuditList({ rows, label = "History", maxHeightClass = "max-h-64", empty = "No history yet." }: { rows: AuditRow[]; label?: string; maxHeightClass?: string; empty?: string }) {
  if (rows.length === 0) return <p className="text-xs text-og-sub">{empty}</p>;
  return (
    <ul aria-label={label} className={cn("divide-y divide-og-line overflow-y-auto rounded-md border border-og-line text-xs", maxHeightClass)} tabIndex={0}>
      {rows.map((r) => (
        <li key={r.id}>
          <details className="group">
            <summary className="flex min-h-[28px] cursor-pointer items-baseline gap-2 px-2 py-1 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-og-accent [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:items-center">
              <time className="shrink-0 tabular-nums text-og-sub">{r.when}</time>
              {r.who ? <span className="shrink-0 font-medium text-og-ink">{r.who}</span> : null}
              <span className="min-w-0 flex-1 truncate text-og-ink group-open:whitespace-normal">{r.summary}</span>
            </summary>
            {r.detail ? <div className="px-2 pb-1 text-og-sub">{r.detail}</div> : null}
          </details>
        </li>
      ))}
    </ul>
  );
}
