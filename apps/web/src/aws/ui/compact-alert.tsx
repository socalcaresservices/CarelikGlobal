import type { ReactNode } from "react";
import { cn } from "@carelik/ui";

const TONES = {
  warn: "border-amber-600 bg-amber-50 text-amber-900",
  danger: "border-red-700 bg-red-50 text-red-800",
  info: "border-og-line bg-og-page text-og-ink",
} as const;
const ICON = { warn: "⚠", danger: "●", info: "ⓘ" } as const;

/**
 * A status warning in one line ("⚠ Hire date missing"). The full explanation appears only after expanding. The symbol and the words carry the
 * meaning; colour only reinforces. With no details it is a plain one-line alert.
 */
export function CompactAlert({ tone = "warn", summary, children, className, testId }: { tone?: keyof typeof TONES; summary: ReactNode; children?: ReactNode; className?: string; testId?: string }) {
  const box = cn("rounded-md border px-2 py-1 text-sm", TONES[tone], className);
  if (!children) {
    return (
      <p role={tone === "danger" ? "alert" : "status"} className={box} data-testid={testId}>
        <span aria-hidden="true">{ICON[tone]} </span>{summary}
      </p>
    );
  }
  return (
    <details className={box} data-testid={testId}>
      <summary className="flex min-h-[28px] cursor-pointer items-center gap-1 font-medium [@media(pointer:coarse)]:min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent">
        <span aria-hidden="true">{ICON[tone]}</span>
        <span className="min-w-0 flex-1">{summary}</span>
        <span className="shrink-0 text-xs font-semibold underline">Details</span>
      </summary>
      <div className="pb-1 pt-0.5 text-xs">{children}</div>
    </details>
  );
}
