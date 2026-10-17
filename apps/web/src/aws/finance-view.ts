// What the Home financial section shows, decided from the month's utilisation rows. Pure, so the rules are tested.
//
// RULES (owner request): an unavailable value is never shown as zero and never as four "Unavailable" cards.
//   * A value the server returned is shown as a value.
//   * A missing value gets a reason ONLY when the data says why: nothing approved yet, no billable hours, or authorizations with no rate.
//   * The missing-rate cause is stated once, with the count from this month's data and a link to the authorizations to fix.
//   * Caregiver cost and margin are not shown at all: Ogevia has no caregiver pay data, so there is nothing to display.
import type { UtilisationRow } from "./aws-workspace";
import { moneyLabel } from "./aws-workspace";

export interface FinanceItem { key: "billable" | "approved" | "unused"; label: string; value: string | null; empty: string | null }
export interface FinanceView { items: FinanceItem[]; missingRates: number; showSection: boolean }

const sumMoney = (rows: UtilisationRow[], key: "billableValueCents" | "approvedValueCents" | "unusedValueCents") =>
  rows.some((r) => r[key] !== null) ? rows.reduce((t, r) => t + Number(r[key] ?? 0), 0) : null;
const sum = (rows: UtilisationRow[], key: keyof UtilisationRow) => rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);

export function financeView(rows: UtilisationRow[]): FinanceView {
  const missingRates = sum(rows, "lineagesWithoutRate");
  const billable = sumMoney(rows, "billableValueCents");
  const approved = sumMoney(rows, "approvedValueCents");
  const unused = sumMoney(rows, "unusedValueCents");
  const items: FinanceItem[] = [
    { key: "billable", label: "Billable value", value: moneyLabel(billable), empty: billable === null && sum(rows, "billableMinutes") === 0 ? "No billable hours yet" : null },
    { key: "approved", label: "Approved for billing", value: moneyLabel(approved), empty: approved === null && sum(rows, "approvedMinutes") === 0 ? "Nothing approved yet" : null },
    { key: "unused", label: "Unused hours (potential value)", value: moneyLabel(unused), empty: unused === null && sum(rows, "remainingMinutes") === 0 ? "No unused hours" : null },
  ];
  return { items, missingRates, showSection: rows.length > 0 };
}
