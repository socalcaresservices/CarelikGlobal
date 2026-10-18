import type { ReactNode } from "react";

/**
 * A page section that is collapsed to one line: title, a status chip and the key figure stay visible in the summary;
 * the detail opens on tap (native <details>: keyboard, touch and screen-reader friendly). Open it by default only when
 * the section needs attention. Content stays in the page either way.
 */
export function SummarySection({ title, status, summary, defaultOpen = false, hideSummaryWhenOpen = false, id, testId, children }: {
  title: string; status?: ReactNode; summary?: ReactNode; defaultOpen?: boolean; hideSummaryWhenOpen?: boolean; id?: string; testId?: string; children: ReactNode;
}) {
  return (
    <details open={defaultOpen} id={id} data-testid={testId} className="group rounded-xl border border-slate-200 bg-og-card">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        {status}
        {summary ? <span className={`min-w-0 flex-1 max-md:order-last max-md:basis-full text-sm text-slate-800${hideSummaryWhenOpen ? " group-open:hidden" : ""}`}>{summary}</span> : <span className="flex-1" />}
        <span aria-hidden="true" className="ml-auto text-slate-600 transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="border-t border-slate-100 p-4">{children}</div>
    </details>
  );
}
