import type { ReactNode } from "react";
import { InfoTip } from "./ui/info-tip";

/**
 * Compact replacement for a ShortHelp block: ONE line. `show` keeps the short sentence visible (use it for a consequence the person must see, for example "cannot be
 * scheduled"); otherwise only an info icon is shown and the sentence plus its details sit behind it. The text always stays in the page for screen readers.
 */
export function Hint({ children, details, show = false, className = "" }: { children: ReactNode; details?: ReactNode; show?: boolean; className?: string }) {
  if (show) {
    return (
      <p className={`flex items-center gap-1 text-xs text-og-sub ${className}`}>
        <span className="min-w-0">{children}</span>
        {details ? <InfoTip label="More information">{details}</InfoTip> : null}
      </p>
    );
  }
  return (
    <div className={`flex items-center ${className}`}>
      <InfoTip label="More information">{children}{details ? <> {details}</> : null}</InfoTip>
    </div>
  );
}
