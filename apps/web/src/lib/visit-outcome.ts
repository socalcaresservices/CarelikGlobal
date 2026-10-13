// Wave 1: plain-language wording shared by the caregiver's final screen and the office review screen.
// The server decides every number and every reason; this file only words them. No payer or client identifiers here.
import { confirmationMethodLabel } from "@/lib/service-verification";

/** The wording the caregiver attests to. The server records the VERSION ("attest-v1"); changing this text means a new version there. */
export const ATTESTATION_TEXT =
  "I attest that I provided this service during the times shown and that the information I entered is accurate.";

/** Reasons a caregiver can give for being unable to get a confirmation (all become manager review; nothing is billable). */
export const NO_SIGNER_REASONS_WAVE1 = [
  "Client declined to sign",
  "Technical problem prevented signing",
  "Signature was accidentally missed before departure",
] as const;

export const UNSCHEDULED_REASON_MIN_LENGTH = 3;
export const isUnscheduledReasonValid = (value: string) => value.trim().length >= UNSCHEDULED_REASON_MIN_LENGTH;

/** One sentence per review reason code, for the caregiver. */
export function caregiverReasonText(code: string, o: { methodLabel: string; ruleMinutes: number | null }): string {
  switch (code) {
    case "unscheduled":
      return "This visit was not on your schedule. Your manager will review it before it can be billed.";
    case "schedule_variance":
      return o.ruleMinutes
        ? `The time worked differs from the scheduled shift by more than ${o.ruleMinutes} minutes. Your manager will review it.`
        : "The time worked differs from the scheduled shift. Your manager will review it.";
    case "no_client_signature":
      return `Confirmed by ${o.methodLabel.toLowerCase()}, without a signature or mark. A manager must review it; it is not billable until then.`;
    case "over_authorization":
      return "Part of this visit is over the authorized time. Only the authorized minutes can be billed, and a manager will review it.";
    default:
      return "A manager will review this visit.";
  }
}

export function describeOutcome(outcome: {
  confirmation_method: string | null;
  review_reasons: string[];
  rule_minutes: number | null;
}) {
  const methodLabel = confirmationMethodLabel(outcome.confirmation_method);
  return {
    methodLabel,
    reasons: outcome.review_reasons.map((code) => caregiverReasonText(code, { methodLabel, ruleMinutes: outcome.rule_minutes })),
  };
}

