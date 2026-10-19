import type { ReactNode } from "react";
import { cn } from "@carelik/ui";
import { InfoTip } from "./info-tip";

/** One short line of guidance (text-xs) with the longer explanation behind an info icon. Replaces ShortHelp's paragraph + "Details" link on dense screens. */
export function HelpLine({ children, details, className }: { children: ReactNode; details?: ReactNode; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-1.5 text-xs text-og-sub", className)}>
      <span>{children}</span>
      {details ? <InfoTip label="More information">{details}</InfoTip> : null}
    </p>
  );
}
