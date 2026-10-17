import type { ReactNode } from "react";
import { cn } from "@carelik/ui";

/**
 * Secondary detail behind one native control. <details> works with keyboard (Enter/Space), touch and screen readers and
 * does not depend on hover. The summary is a 44px touch target.
 */
export function Disclosure({ summary, children, className, defaultOpen = false }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className={cn("group text-sm", className)}>
      <summary className="inline-flex min-h-[44px] cursor-pointer items-center gap-1 text-og-link underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:min-h-[32px]">
        {summary}
      </summary>
      <div className="pb-1 pt-1 text-og-sub">{children}</div>
    </details>
  );
}
