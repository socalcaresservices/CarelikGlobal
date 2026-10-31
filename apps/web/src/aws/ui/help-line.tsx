import type { ReactNode } from "react";
import { cn } from "@carelik/ui";
import { InfoTip } from "./info-tip";

/** Guidance as a compact Help control (an info icon); the text stays in the page for screen readers. `important` keeps the short line visible for a consequence the person must see. */
export function HelpLine({ children, details, className, important = false }: { children: ReactNode; details?: ReactNode; className?: string; important?: boolean }) {
  if (important) {
    return (
      <p className={cn("flex flex-wrap items-center gap-1.5 text-xs text-og-sub", className)}>
        <span>{children}</span>
        {details ? <InfoTip label="More information">{details}</InfoTip> : null}
      </p>
    );
  }
  return (
    <div className={cn("flex items-center", className)}>
      <InfoTip label="More information">{children}{details ? <> {details}</> : null}</InfoTip>
    </div>
  );
}
