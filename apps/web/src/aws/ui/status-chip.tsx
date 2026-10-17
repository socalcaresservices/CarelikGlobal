import { cn } from "@carelik/ui";
import { TONE, type Tone } from "../attention";

/** One status word with its symbol. Colour reinforces the word; it is never the only signal. */
export function StatusChip({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  const t = TONE[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold", t.badge, className)}>
      <span aria-hidden="true">{t.icon}</span>
      {children}
    </span>
  );
}
