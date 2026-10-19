import { useId, useState, type ReactNode } from "react";
import { cn } from "@carelik/ui";

/**
 * An info icon with its explanation behind it. Hover, keyboard focus or a tap shows it; Escape closes it. The text stays in the page for screen readers
 * (aria-describedby) and never moves the layout (it floats). 44 px target on touch screens. Use for background and instructions, never for a warning
 * the person must act on (use CompactAlert for that).
 */
export function InfoTip({ children, label = "More information", className }: { children: ReactNode; label?: string; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={cn("group relative inline-flex align-middle", className)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-og-line text-[11px] font-semibold leading-none text-og-sub hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:text-sm"
      >
        <span aria-hidden="true">i</span>
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "absolute left-0 top-full z-30 mt-1 w-64 max-w-[80vw] rounded-lg border border-og-line bg-og-card p-2 text-xs font-normal normal-case text-og-ink shadow-md",
          open ? "block" : "hidden group-hover:block group-focus-within:block",
        )}
      >
        {children}
      </span>
    </span>
  );
}
