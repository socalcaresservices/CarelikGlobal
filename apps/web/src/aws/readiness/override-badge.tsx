import { OVERRIDE_BADGE_TEXT } from "./readiness-data";

/** "Approved by override — not signed in": shown on the profile, the Care Team list and the schedule until the caregiver's first sign-in. */
export function OverrideBadge({ className = "" }: { className?: string }) {
  return <span data-testid="override-badge" className={`inline-block whitespace-nowrap rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 ${className}`}>{OVERRIDE_BADGE_TEXT}</span>;
}
