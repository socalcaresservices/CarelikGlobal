import { useState, type ReactNode } from "react";

/**
 * Layout pieces for the caregiver profile: one compact row per question or requirement (label, saved value, status, action),
 * and four tabs. They carry no data of their own; every value and action is bound by the caller to existing application data.
 */
export type Tone = "ok" | "warn" | "bad" | "neutral" | "saved";

const TONE: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-950",
  warn: "bg-amber-100 text-amber-950",
  bad: "bg-red-100 text-red-900",
  neutral: "bg-slate-100 text-slate-900",
  saved: "bg-sky-100 text-sky-950",
};

export function StatusChip({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return <span data-testid={testId} data-tone={tone} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export const rowButton = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50 md:min-h-[32px]";

/** A list of rows inside one bordered block, with an optional heading. */
export function ProfileBlock({ title, label, children }: { title?: string; label?: string; children: ReactNode }) {
  return (
    <section aria-label={label ?? title} className="space-y-1">
      {title ? <h3 className="text-sm font-semibold text-slate-950">{title}</h3> : null}
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-og-card">{children}</ul>
    </section>
  );
}

/**
 * One row. Desktop: label, saved value, status and action on one line. Phone: label and status together, the action beside them,
 * the value underneath; long values wrap and nothing scrolls sideways. `panel` opens underneath the row, full width.
 */
export function ProfileRow({ label, value, status, action, panel, testId, id, requirement }: {
  label: ReactNode; value?: ReactNode; status?: ReactNode; action?: ReactNode; panel?: ReactNode; testId?: string | undefined; id?: string | undefined; requirement?: string | undefined;
}) {
  return (
    <li className="px-3 py-2" data-testid={testId} id={id} data-requirement={requirement}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[10rem_minmax(0,1fr)_auto_5.5rem]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:contents">
          <span className="text-sm font-semibold text-slate-950 md:col-start-1 md:row-start-1">{label}</span>
          {status ? <span className="md:col-start-3 md:row-start-1 md:justify-self-start">{status}</span> : null}
        </div>
        <div className="col-span-2 row-start-2 min-w-0 break-words text-sm text-slate-800 md:col-span-1 md:col-start-2 md:row-start-1">{value ?? null}</div>
        {action ? <div className="col-start-2 row-start-1 flex flex-wrap justify-end gap-2 md:col-start-4 md:justify-self-end">{action}</div> : null}
      </div>
      {panel ? <div className="mt-2">{panel}</div> : null}
    </li>
  );
}

/** A row whose saved value is shown by default; the editor opens only on Edit or Manage. */
export function EditableRow({ label, value, status, canEdit, actionLabel = "Edit", testId, children }: {
  label: string; value: ReactNode; status?: ReactNode; canEdit: boolean; actionLabel?: "Edit" | "Manage"; testId?: string | undefined; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ProfileRow testId={testId} label={label} value={value} status={status}
      action={canEdit ? <button type="button" className={rowButton} aria-expanded={open} aria-label={`${open ? "Close" : actionLabel} ${label.toLowerCase()}`} onClick={() => setOpen((v) => !v)}>{open ? "Close" : actionLabel}</button> : null}
      panel={open ? children : null} />
  );
}

export interface ProfileTab { id: string; label: string }

/** Four tabs. The selected one is marked for assistive technology; on a phone they wrap instead of scrolling sideways. */
export function ProfileTabs({ tabs, active, onChange }: { tabs: readonly ProfileTab[]; active: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Caregiver profile sections" className="flex flex-wrap gap-x-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={active === t.id} aria-controls={`panel-${t.id}`} tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={`min-h-[44px] border-b-2 px-3 text-sm font-semibold md:min-h-[36px] ${active === t.id ? "border-teal-800 text-teal-900" : "border-transparent text-slate-700 hover:text-slate-950"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
