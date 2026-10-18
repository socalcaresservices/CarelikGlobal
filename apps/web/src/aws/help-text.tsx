import type { ReactNode } from "react";

/**
 * A short line of plain-language guidance, with the longer explanation behind "Details".
 * Warnings and required instructions go in the short line; background goes in details. Nothing is removed, only moved.
 */
export function ShortHelp({ children, details, className = "text-sm text-slate-600" }: { children: ReactNode; details?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p>{children}</p>
      {details ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline [@media(pointer:coarse)]:min-h-[44px]">Details</summary>
          <p className="mt-1">{details}</p>
        </details>
      ) : null}
    </div>
  );
}
