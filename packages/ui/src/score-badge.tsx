import { cn } from "./cn";
import { toneTextClasses, type StatusTone } from "./status-badge";

// CareScore/GeoScore badges, per the BUILD 001.5 design-system spec.
//
// CareScore is real as of the caregiver-detail-page rebuild: it's the
// same per-pair match formula from list_caregiver_matches()/
// list_client_matches_for_caregiver() (see
// docs/phase-1-foundation.md's Increment 22 and
// supabase/migrations/20260811041032_list_client_matches_for_caregiver.sql),
// computed from real columns (address/language/skills overlap,
// availability, shared shift/incident history) - never fabricated.
//
// GeoScore has no real spec or data yet (no geocoding/distance feature
// exists - see design-system.md's "Not yet built" section) and is not
// currently rendered anywhere. "geo" stays in ScoreKind so the component
// is ready whenever real geocoding is built, but nothing should pass
// preview data for it in the meantime - see the git history for how the
// old sample-data version of this component worked if that's needed as
// a reference.
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
  /** Only for sample/non-real data - shows a visible "Preview" tag. Omit for a real score. */
  preview?: boolean;
  className?: string;
}

export function ScoreBadge({ kind, value, preview, className }: ScoreBadgeProps) {
  const tone = bandTone(value);
  return (
    <div
      className={cn(
        "relative inline-flex min-w-[5.5rem] flex-col items-center gap-0.5 rounded-2xl border border-slate-200 bg-white px-4 py-3",
        className
      )}
    >
      {preview ? (
        <span className="absolute -right-2 -top-2 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          Preview
        </span>
      ) : null}
      <span className={cn("text-metric tabular-nums", toneTextClasses[tone])}>{Math.round(value)}</span>
      <span className="text-caption font-medium text-slate-500">{KIND_LABEL[kind]}</span>
    </div>
  );
}
