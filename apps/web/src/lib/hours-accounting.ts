/**
 * Hours accounting names and the per-authorization equation (migration 0079, owner requirement 2.2).
 *
 *   Authorized = Billable + Rounding + Pending + Reserved + Hours left        (Hours left is signed; a negative amount is shown as "Over limit")
 *
 * The server computes every figure (ogevia.hours_breakdown); this file only names and lays them out, so no screen recalculates anything.
 * Hours left and Over limit are PER AUTHORIZATION. A total across authorizations shows both side by side and never nets one against the other.
 * "Worked, not billable" is a reconciliation line outside the equation: actual worked time is never redefined as capped billable time.
 */
import { formatDuration } from "@/lib/service-verification";

export interface HoursFields {
  authorizedMinutes: number;
  hoursBillableMinutes?: number | null;
  hoursRoundingMinutes?: number | null;
  hoursPendingMinutes?: number | null;
  hoursPendingReviewMinutes?: number | null;
  hoursPendingHeldMinutes?: number | null;
  hoursPendingUnreservedMinutes?: number | null;
  hoursReservedMinutes?: number | null;
  /** Signed: negative means Over limit. */
  hoursLeftMinutes?: number | null;
  hoursOverLimitMinutes?: number | null;
  hoursWorkedNotBillableMinutes?: number | null;
  /** Shift time still held for a visit whose review was closed as not billable (counted inside Reserved; whether to release it is a billing-policy decision). */
  hoursClosedNotBillableHeldMinutes?: number | null;
  hoursClosedNotBillableWorkedMinutes?: number | null;
}

export const HOURS_NAMES = {
  authorized: "Authorized",
  billable: "Billable",
  rounding: "Rounding",
  pending: "Pending",
  reserved: "Reserved",
  left: "Hours left",
  over: "Over limit",
  workedNotBillable: "Worked, not billable",
} as const;

export const HOURS_DEFINITIONS = {
  billable: "Confirmed billable time (signed visits and accepted late confirmations).",
  rounding: "Approved billing rounding adjustments, positive or negative, counted once.",
  pending: "Worked but not yet billable: visits awaiting confirmation or in review, and the shift time held for them.",
  reserved: "Scheduled time not yet delivered: shifts ahead or under way, and shifts that ended with no visit record until a person decides.",
  left: "Authorized minus Billable, Rounding, Pending and Reserved. Worked out for each authorization on its own.",
  over: "The amount by which an authorization is beyond its limit. It is never offset against another authorization's unused time.",
  workedNotBillable: "Time worked beyond what counts as Billable or Pending (the billing cap, or a review closed as not billable). Shown so no worked time is hidden.",
} as const;

export const HOURS_EQUATION_TEXT = "Authorized = Billable + Rounding + Pending + Reserved + Hours left. If Hours left is negative, that amount is shown as Over limit.";
export const HOURS_TOTAL_NOTE = "On a total, Hours left adds only the authorizations that still have time and Over limit adds only those that are over. They are not offset against each other.";

export const hasHours = (r: HoursFields): boolean => r.hoursLeftMinutes !== undefined && r.hoursLeftMinutes !== null;

/** Hours with one decimal, e.g. 750 min -> "12.5 h", 2400 min -> "40 h". Display only; the exact hours and minutes stay in each Details. */
export function formatHours(minutes: number): string {
  const h = Math.round((Math.abs(minutes) / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h.toFixed(0) : h.toFixed(1)} h`;
}

/** ONE label and ONE value for one authorization: "Hours left: 12.5 h", or "Over limit: 2.5 h" when negative (never offset against another authorization). */
export function hoursLeftLine(leftMinutes: number): { label: string; value: string; text: string; over: boolean } {
  const over = leftMinutes < 0;
  const label = over ? HOURS_NAMES.over : HOURS_NAMES.left;
  const value = formatHours(leftMinutes);
  return { label, value, text: `${label}: ${value}`, over };
}

/** "Hours left" with its amount, or "Over limit" with the amount over, for ONE authorization. */
export function hoursLeftFigure(leftMinutes: number): { label: string; value: string; over: boolean } {
  return leftMinutes < 0
    ? { label: HOURS_NAMES.over, value: formatDuration(-leftMinutes), over: true }
    : { label: HOURS_NAMES.left, value: formatDuration(leftMinutes), over: false };
}

export interface HoursLine { key: string; label: string; minutes: number; note?: string; tone?: "red" }

/** The equation lines for one authorization, in order. Rounding appears only when it is not zero; Pending parts are listed when there are any. */
export function hoursEquation(r: HoursFields): HoursLine[] {
  const left = Number(r.hoursLeftMinutes ?? 0);
  const lines: HoursLine[] = [
    { key: "authorized", label: HOURS_NAMES.authorized, minutes: r.authorizedMinutes },
    { key: "billable", label: HOURS_NAMES.billable, minutes: Number(r.hoursBillableMinutes ?? 0) },
  ];
  if (Number(r.hoursRoundingMinutes ?? 0) !== 0) lines.push({ key: "rounding", label: HOURS_NAMES.rounding, minutes: Number(r.hoursRoundingMinutes), note: "approved adjustments, counted once" });
  lines.push({ key: "pending", label: HOURS_NAMES.pending, minutes: Number(r.hoursPendingMinutes ?? 0) });
  lines.push({ key: "reserved", label: HOURS_NAMES.reserved, minutes: Number(r.hoursReservedMinutes ?? 0) });
  lines.push(left < 0
    ? { key: "over", label: HOURS_NAMES.over, minutes: -left, tone: "red", note: "Hours left is negative" }
    : { key: "left", label: HOURS_NAMES.left, minutes: left });
  return lines;
}

/** The balance a caregiver sees at Start Visit, and how it differs from the office Hours left. The server computes both (0079). */
export interface CaregiverBalance { leftToRecordMinutes: number; hoursLeftMinutes: number | null; officePendingMinutes: number; officeReservedMinutes: number }

export const CAREGIVER_LEFT_LABEL = "Left to record";
export function caregiverDifferenceNote(b: CaregiverBalance | null): string {
  const base = "Left to record counts confirmed time only (Billable, Rounding and visits waiting for review): the room used when a visit is confirmed.";
  if (!b || b.hoursLeftMinutes === null) return `${base} The office Hours left also deducts time that is Pending and Reserved for scheduled visits, so it can be lower.`;
  const parts: string[] = [];
  if (b.officeReservedMinutes > 0) parts.push(`${formatDuration(b.officeReservedMinutes)} Reserved for scheduled visits`);
  if (b.officePendingMinutes > 0) parts.push(`${formatDuration(b.officePendingMinutes)} Pending`);
  return parts.length === 0
    ? `${base} The office Hours left is the same today: nothing is Pending or Reserved.`
    : `${base} The office Hours left is lower by ${parts.join(" and ")}.`;
}

/** Text for a CSV cell or a sentence: the time left, or "Over limit" with the amount over. One authorization only. */
export function hoursLeftText(leftMinutes: number | null | undefined): string {
  if (leftMinutes === null || leftMinutes === undefined) return "—";
  const f = hoursLeftFigure(Number(leftMinutes));
  return f.over ? `${f.label} ${f.value}` : f.value;
}
