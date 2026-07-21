import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

// A dropdown menu button for row-level actions (edit, revoke, view
// history...) so dense list rows can collapse several inline buttons
// into one compact trigger - part of "easy to scan, not a collection
// of widely separated controls." Each item is rendered by the caller
// (so it can be a <button>, a router <Link>, whatever fits), this
// component only owns the trigger/open state/positioning/keyboard close.
export interface QuickActionMenuProps {
  label?: string;
  children: ReactNode;
  className?: string;
}

export function QuickActionMenu({ label = "Actions", children, className }: QuickActionMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <div ref={containerRef} className={cn("relative inline-block text-left", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className="absolute right-0 z-10 mt-1 min-w-[10rem] rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
