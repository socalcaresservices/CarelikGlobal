// Test helper: empty answers for the readiness endpoints (0039-0041) so screens that include the new cards render in
// tests that are about something else. SYNTHETIC; used by fake API fetch implementations as a fallback.
const EMPTY: Array<[RegExp, unknown]> = [
  [/^\/v1\/availability\/me\/state$/, { availability: { hasRecord: false, pending: null, lastDecision: null } }],
  [/^\/v1\/availability\/requests$/, { requests: [] }],
  [/^\/v1\/caregivers\/[^/]+\/availability$/, { availability: { timezone: "America/Los_Angeles", version: 0, provided: false, windows: [], unavailable: [], updatedAt: null, updatedBy: null, updateSource: null } }],
  [/^\/v1\/service-approvals\/me$/, { approvals: [] }],
  [/^\/v1\/caregivers\/[^/]+\/service-approvals$/, { approvals: [] }],
  [/^\/v1\/experience\/me$/, { experience: [] }],
  [/^\/v1\/caregivers\/[^/]+\/experience$/, { experience: [] }],
  [/^\/v1\/experience-tags$/, { tags: [] }],
  [/^\/v1\/(caregivers|clients)\/[^/]+\/location$/, { location: null }],
  [/^\/v1\/clients\/[^/]+\/support-preferences$/, { preferences: [] }],
  [/^\/v1\/readiness\/flags$/, { flags: [] }],
  [/^\/v1\/readiness\/settings$/, { readiness: null }],
  [/^\/v1\/match\/settings$/, { match: null }],
  [/^\/v1\/documents\/compliance$/, { compliance: [] }],
  [/^\/v1\/document-types\/required$/, { required: [] }],
];

export function readinessFake(method: string, pathname: string): Response | null {
  if (method !== "GET") return null;
  const hit = EMPTY.find(([re]) => re.test(pathname));
  return hit ? new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } }) : null;
}

/** A match-v1 candidate as the API returns it (camelCase). SYNTHETIC. */
export function fakeCandidate(over: Record<string, unknown> = {}) {
  return {
    caregiverRecordId: "cccccccc-0000-4000-8000-000000000002", caregiverCode: "CG-2", caregiverName: "Synthetic Caregiver Two",
    eligibility: "eligible", travelLimitExceeded: false, checks: [{ key: "status", status: "pass", label: "Active" }, { key: "documents", status: "pass", label: "Documents current" }],
    reasons: [], unchecked: [],
    cover: { occurrences: 1, ready: 1, needsOverride: 0, blocked: 0, partial: false, covered: [], notCovered: [] },
    approxDistanceMiles: 4.2, score: 87, scoreStatus: "complete", scoreVersion: "match-v1", verifiedMatches: 1,
    matchedTags: [{ tagId: "t1", name: "Dementia care", weight: 3 }],
    components: [
      { key: "availability", status: "known", value: 1, weight: 0.5, points: 50, detail: { coveredMinutes: 120, requestedMinutes: 120 }, source: {} },
      { key: "location", status: "known", value: 0.72, weight: 0.25, points: 18, detail: { approxDistanceMiles: 4.2, referenceRadiusMiles: 15 }, source: {} },
      { key: "experience", status: "known", value: 0.76, weight: 0.25, points: 19, detail: { requestedTags: 1, verifiedMatches: 1, experienceReviewed: true }, source: {} },
    ],
    ...over,
  };
}
export function fakeMatches(candidates: unknown[], serviceChecks: "on" | "off" = "on") {
  return { matches: { version: "match-v1", settings: { referenceRadiusMiles: 15, locationEnabled: true, serviceChecks }, candidates } };
}
