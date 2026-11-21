// PREVIEW ONLY. The small "Preview · <commit>" pill: which commit this is, who you are viewing as, and what changed.
import { useState } from "react";
import type { PreviewData } from "./replay";

export function PreviewBadge({ data, persona }: { data: PreviewData; persona: string }) {
  const sha7 = data.meta.sha.slice(0, 7);
  const [open, setOpen] = useState(false);
  const btn = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-900";
  return (
    <div style={{ position: "fixed", right: 8, bottom: 80, zIndex: 60, maxWidth: "min(92vw, 22rem)" }} className="print:hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-h-[44px] rounded-full bg-slate-900 px-3 text-xs font-semibold text-white shadow-lg">
        Preview · {sha7}
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-300 bg-white p-3 text-xs text-slate-900 shadow-xl">
          <p className="font-semibold">Preview of commit {data.meta.sha}</p>
          <p>Built {data.meta.builtAt}. Synthetic data only. Nothing is saved, except the caregiver visit (Start, End, Confirm).</p>
          <p className="flex flex-wrap items-center gap-1">View as:
            {data.meta.personas.map((k) => <a key={k} href={`?as=${k}`} className={btn} aria-current={k === persona ? "true" : undefined}>{k}</a>)}
          </p>
          <p className="font-semibold">What changed</p>
          <ul className="list-disc space-y-0.5 pl-4">{data.meta.changes.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

