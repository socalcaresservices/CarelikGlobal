import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * A panel that slides in from the right (full screen on a phone) for a form or details that should not push the page down.
 * Escape, the close button and a tap on the dimmed page close it; focus goes into it on open and returns to what opened it. The page behind is not scrollable while it is open.
 */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 print:hidden" data-testid="drawer">
      <div aria-hidden="true" className="absolute inset-0 bg-og-ink/40" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className="absolute inset-y-0 right-0 flex w-full flex-col bg-og-card shadow-2xl md:w-[460px] md:max-w-[92vw]">
        <div className="flex items-center gap-2 border-b border-og-line px-4 py-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold text-og-ink">{title}</h2>
          <button type="button" data-drawer-close aria-label="Close" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-og-ink hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-accent">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
