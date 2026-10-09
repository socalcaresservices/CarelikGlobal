// Display helpers for caregiver readiness and explainable matching (migrations 0039-0041).
// Pure functions only: every number and state comes from the server; nothing here decides eligibility or score.

export type Eligibility = "eligible" | "partial" | "needs_override" | "not_eligible";

export const ELIGIBILITY: Record<Eligibility, { label: string; className: string }> = {
  eligible: { label: "Eligible", className: "bg-teal-50 text-teal-900 ring-1 ring-teal-200" },
  partial: { label: "Partly eligible", className: "bg-amber-100 text-amber-900" },
  needs_override: { label: "Needs override", className: "bg-amber-100 text-amber-900" },
  not_eligible: { label: "Not eligible", className: "bg-slate-200 text-slate-800" },
};

export const CHECK_LABEL: Record<string, string> = {
  status: "Status",
  documents: "Documents",
  service: "Service approval",
  availability: "Availability",
  authorization: "Authorization",
  conflicts: "Schedule",
  requirements: "Client needs",
};

export const COMPONENT_LABEL: Record<string, string> = {
  availability: "Availability",
  location: "Location",
  experience: "Experience",
};

export const DOCUMENT_STATE_LABEL: Record<string, string> = {
  ok: "Verified",
  ends_before_end: "Ends before service",
  not_yet_valid: "Not yet valid",
  expired: "Expired",
  needs_review: "Needs review",
  pending: "Awaiting review",
  revoked: "Revoked",
  rejected: "Rejected",
  missing: "Missing",
};

export interface MatchComponent {
  key: "availability" | "location" | "experience";
  status: "known" | "unknown" | "not_applicable";
  value: number | null;
  weight: number;
  points: number | null;
  detail: Record<string, unknown>;
  source: Record<string, unknown>;
}

export interface MatchCandidate {
  caregiverRecordId: string;
  caregiverCode: string;
  caregiverName: string;
  eligibility: Eligibility;
  travelLimitExceeded: boolean;
  checks: Array<{ key: string; status: string; label?: string }> | null;
  reasons: Array<{ code: string; label: string }>;
  unchecked: string[];
  cover: {
    occurrences: number; ready: number; needsOverride: number; blocked: number; partial: boolean;
    covered: Array<{ startsAt: string; endsAt: string }>;
    notCovered: Array<{ startsAt: string; endsAt: string; status: string; reasons: Array<{ code: string; label: string }> }>;
  };
  approxDistanceMiles: number | null;
  score: number | null;
  scoreStatus: "complete" | "incomplete";
  scoreVersion: string;
  verifiedMatches: number;
  matchedTags: Array<{ tagId: string; name: string; weight: number }>;
  components: MatchComponent[];
}

export interface MatchResult {
  version: string;
  settings: { referenceRadiusMiles: number; locationEnabled: boolean; serviceChecks: "on" | "off" };
  candidates: MatchCandidate[];
}

/** "82" for a complete score, "Incomplete" when an applicable input is unknown. Never a made-up number. */
export function scoreLabel(c: Pick<MatchCandidate, "score" | "scoreStatus">): string {
  return c.scoreStatus === "complete" && c.score !== null ? String(c.score) : "Incomplete";
}

export function distanceLabel(miles: number | null): string {
  return miles === null ? "Not available" : `~${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/** Why a component has no value, in the words the table uses. */
export function componentNote(c: MatchComponent): string {
  if (c.status === "not_applicable") return c.key === "location" ? "Off — weight moved to the other parts" : "Not requested — weight moved to the other parts";
  if (c.status === "unknown") {
    if (c.key === "location") {
      const d = c.detail as { caregiverLocation?: string; clientLocation?: string; coordinates?: string | null };
      if (d.coordinates) return "ZIP not in the distance list";
      const missing = [d.clientLocation === "not recorded" ? "client" : null, d.caregiverLocation === "not recorded" ? "caregiver" : null].filter(Boolean);
      return `ZIP not recorded (${missing.join(" and ") || "unknown"})`;
    }
    return "Experience not reviewed yet";
  }
  return "";
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** Sentence for the ranking order, shown under the table so the sort is never a mystery. */
export const RANKING_NOTE =
  "Sorted by eligibility, then score, then nearer, then more verified experience, then caregiver code. Score is a guide for the administrator, not an approval.";

/** Minutes → "2 hr 30 min". */
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h && m ? `${h} hr ${m} min` : h ? `${h} hr` : `${m} min`;
}
