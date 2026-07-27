import { cn } from "./cn";
import { toneTextClasses, type StatusTone } from "./status-badge";

// CareScore/GeoScore badges, per the BUILD 001.5 design-system spec.
//
// IMPORTANT - this is a deliberate, explicit exception to
// docs/design-system.md's "no fabricated numbers" rule, not an oversight.
// A real per-pair CareScore already exists (see
// docs/phase-1-foundation.md's Increment 22) but only as a ranking used
// inside the "assign a caregiver to a shift" dropdown - there's no
// general-purpose score to show on a caregiver's own record page, and
// there's no GeoScore at all (CareScore's proximity component today is a
// zip/city/state text match, not a real distance calculation - see
// design-system.md's "Not yet built" section). The user explicitly chose
// to ship these badges anyway with sample data, so the *component* can be
// built and placed now, deferring the real scoring model to a later build.
//
// To keep that exception impossible to use by accident, `preview` is a
// required, literal `true` prop (not a boolean with a default) - every
// call site has to explicitly acknowledge "this number is not real" in
// its own JSX, and the badge always renders a visible "Preview" tag.
// When a real score model exists, delete `preview` (making it a compile
// error everywhere this is used) and wire in the real value.
export type ScoreKind = "care" | "geo";

const KIND_LABEL: Record<ScoreKind, string> = {
  care: "CareScore",
  geo: "GeoScore"
};

function bandTone(value: number): StatusTone {
  if (value >= 80) return "success";
  if (value >= 60) return "warning";
  return "danger";
}

export interface ScoreBadgeProps {
  kind: ScoreKind;
  /** 0-100. */
  value: number;
  /** Must be `true` - see the file-level comment above. */
  preview: true;
  className?: string;
}

export function ScoreBadge({ kind, value, preview, className }: ScoreBadgeProps) {
  if (!preview) return null;
  const tone = bandTone(value);
  return (
    <div
      className={cn(
        "relative inline-flex min-w-[5.5rem] flex-col items-center gap-0.5 rounded-2xl border border-slate-200 bg-white px-4 py-3",
        className
      )}
    >
      <span className="absolute -right-2 -top-2 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        Preview
      </span>
      <span className={cn("text-metric tabular-nums", toneTextClasses[tone])}>{Math.round(value)}</span>
      <span className="text-caption font-medium text-slate-500">{KIND_LABEL[kind]}</span>
    </div>
  );
}
