// Suggested replacements. The server already ranks the candidates (eligibility first, then the agency's scoring rule, with fixed tie-breaks: assigned to this client, fewer
// minutes already scheduled that week, caregiver code). The screen keeps exactly that order and only drops anyone who is not eligible or is the caregiver being replaced.
export interface Candidate {
  caregiverRecordId: string; caregiverCode: string; name: string; eligibility: "eligible" | "partial" | "not_eligible"; assignedToClient: boolean; scheduledMinutesThatWeek: number;
  score: { ruleVersion: string; ruleStatus: string; complete: boolean; label: string | null; total: number | null; components: Array<{ name: string; weight: number; points: number | null; status: string; reason: string }> };
}
export interface Matches { ruleVersion: string; ruleStatus: string; rankedByScore: boolean; note: string | null; candidates: Candidate[] }

export function eligibleReplacements(matches: Matches, replacing: string | null): Candidate[] {
  return matches.candidates.filter((c) => c.eligibility === "eligible" && c.caregiverRecordId !== replacing);
}
