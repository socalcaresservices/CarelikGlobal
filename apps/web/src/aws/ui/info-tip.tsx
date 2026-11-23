import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePageHelp } from "./page-help-context";
import { Link } from "react-router-dom";
import { cn } from "@carelik/ui";

/** The longest help text shown in a tip, in characters. A longer explanation belongs behind the optional further-detail link. */
export const INFO_TIP_MAX_CHARS = 250;

/**
 * An info icon with its explanation behind it: a short title, one to three plain sentences and, optionally, a link to more detail.
 * Hover, keyboard focus, a click or a tap shows it; Escape, the close button, the icon again, or a tap elsewhere dismisses it. It floats (never moves the layout and never
 * blocks the page), and the text stays in the page for screen readers (aria-describedby). 44 px target on touch screens. Use for background and instructions, never for a
 * warning the person must act on (use CompactAlert for that).
 */
export function InfoTip({ children, label = "More information", title, more, className }: { children: ReactNode; label?: string; title?: string; more?: { to: string; label?: string }; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // Dismissed on purpose (close button, Escape): stays hidden even while the pointer rests on the icon or it keeps focus, until the person leaves and comes back or taps the icon.
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Inside the app shell the tip joins the page's one help panel (opened by the "?" in the header) instead of floating beside a field.
  const page = usePageHelp();
  const register = page?.register;
  useEffect(() => (register ? register(id) : undefined), [register, id]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (page) {
    return page.slot
      ? createPortal(
          <section aria-label={label} className="space-y-0.5 border-b border-og-line pb-2 last:border-0 last:pb-0">
            {title ? <p className="text-[13px] font-semibold">{title}</p> : null}
            <p className="text-xs leading-snug">{children}</p>
            {more ? <Link to={more.to} className="inline-block text-xs font-medium text-og-link underline">{more.label ?? "More detail"}</Link> : null}
          </section>,
          page.slot,
        )
      : null;
  }
  return (
    <span
      ref={root}
      className={cn("group relative inline-flex align-middle", className)}
      onMouseLeave={() => setDismissed(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDismissed(false); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setDismissed(true); button.current?.focus(); } }}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => { setDismissed(false); setOpen((o) => !o); }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-og-line text-[11px] font-semibold leading-none text-og-sub hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:text-sm"
      >
        <span aria-hidden="true">i</span>
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "absolute left-0 top-full z-30 mt-1 w-64 max-w-[80vw] rounded-lg border border-og-line bg-og-card p-2 pr-7 text-xs font-normal normal-case leading-snug text-og-ink shadow-md",
          dismissed ? "hidden" : open ? "block" : "hidden group-hover:block group-focus-within:block",
        )}
      >
        {title ? <span className="mb-0.5 block text-[12px] font-semibold">{title}</span> : null}
        <span className="block">{children}</span>
        {more ? <Link to={more.to} className="mt-1 inline-block font-medium text-og-link underline">{more.label ?? "More detail"}</Link> : null}
        <button type="button" aria-label="Close help" onClick={() => { setOpen(false); setDismissed(true); button.current?.focus(); }} className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded text-og-sub hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-accent">
          <span aria-hidden="true">×</span>
        </button>
      </span>
    </span>
  );
}
