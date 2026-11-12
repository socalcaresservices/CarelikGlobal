import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHelpContext, usePageHelp, type PageHelpValue } from "./page-help-context";
import { cn } from "@carelik/ui";

/**
 * One help affordance per page. Tips written with <InfoTip> do not float next to fields any more: inside the app shell each one adds its short text to a single
 * panel opened by ONE "?" button in the page header. The text never sits over, or between, a field and its label. Outside the shell (a component rendered on
 * its own) InfoTip keeps its old inline behaviour.
 */
export function PageHelpProvider({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  // A new page starts with the panel closed.
  useEffect(() => setOpen(false), [resetKey]);
  const register = useCallback((id: string) => {
    setIds((cur) => new Set(cur).add(id));
    return () => setIds((cur) => { const next = new Set(cur); next.delete(id); return next; });
  }, []);
  const value = useMemo<PageHelpValue>(() => ({ slot, count: ids.size, open, setOpen, register }), [slot, ids, open, register]);
  return (
    <PageHelpContext.Provider value={value}>
      {children}
      <PageHelpSlot setSlot={setSlot} />
    </PageHelpContext.Provider>
  );
}

/** The panel's container. It is always mounted (so tips can render into it) and hidden until the "?" is pressed. */
function PageHelpSlot({ setSlot }: { setSlot: (el: HTMLElement | null) => void }) {
  const page = usePageHelp();
  const open = page?.open ?? false;
  return (
    <div
      role="region"
      aria-label="Help for this page"
      data-testid="page-help-panel"
      className={cn("fixed right-3 top-16 z-40 max-h-[70vh] w-[22rem] max-w-[calc(100vw-1.5rem)] space-y-3 overflow-y-auto rounded-lg border border-og-line bg-og-card p-3 text-sm text-og-ink shadow-lg print:hidden", !open && "hidden")}
      ref={setSlot}
    />
  );
}

/** The single "?" in the page header. Shown only when the page has help to show. */
export function PageHelpButton() {
  const page = usePageHelp();
  useEffect(() => {
    if (!page?.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") page.setOpen(false); };
    const away = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest('[data-testid="page-help-panel"], [data-testid="page-help-button"]')) page.setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", away);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", away); };
  }, [page]);
  if (!page || page.count === 0) return null;
  return (
    <button
      type="button"
      data-testid="page-help-button"
      aria-label="Help for this page"
      aria-expanded={page.open}
      onClick={() => page.setOpen(!page.open)}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-lg border border-og-line px-3 text-sm font-semibold text-og-ink hover:bg-og-page md:min-h-[40px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent"
    >
      <span aria-hidden="true">?</span><span className="hidden sm:inline">Help</span>
    </button>
  );
}
