import { describe, expect, it } from "vitest";
import { actionCategories, actionNeededState, actionNeededTotal, reminders } from "./action-needed";
import type { AttentionSummary } from "./aws-workspace";

const base: AttentionSummary = {
  missingTimeOut: 1, notConfirmed: 2, needsReview: 3, billingReadyUnapproved: 4, total: 999,
  lateResponsesToReview: 5, uncoveredShifts: 6, documentsBlocking: 7, documentsToReview: 8,
  awaitingSignature: 20, documentsExpiring: 30,
};

describe("actionNeededTotal", () => {
  it("is exactly the sum of the eight categories; reminders and the legacy server total are ignored", () => {
    expect(actionNeededTotal(base)).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7 + 8);
    expect(actionCategories(base).map((c) => c.label)).toEqual([
      "Missing Clock-Out", "Awaiting Confirmation", "Visits to Review", "Signatures to Review", "Unfilled Shifts", "Overdue Documents", "Documents to Review", "Ready for Approval",
    ]);
  });

  it("maps each label to its existing server field and keeps the existing destinations", () => {
    const by = Object.fromEntries(actionCategories(base).map((c) => [c.key, c]));
    expect(by.missingClockOut).toMatchObject({ count: 1, to: "/service-verification/reports?view=exceptions" });
    expect(by.awaitingConfirmation).toMatchObject({ count: 2, to: "/service-verification/reports?view=exceptions" });
    expect(by.visitsToReview).toMatchObject({ count: 3, to: "/service-verification/reports?view=exceptions" });
    expect(by.signaturesToReview).toMatchObject({ count: 5, to: "/billing-review" });
    expect(by.unfilledShifts).toMatchObject({ count: 6, to: "/schedule" });
    expect(by.overdueDocuments).toMatchObject({ count: 7, to: "/documents" });
    expect(by.documentsToReview).toMatchObject({ count: 8, to: "/documents" });
    expect(by.readyForApproval).toMatchObject({ count: 4, to: "/billing-review" });
  });

  it("omits categories the viewer may not see (null) and counts nothing for them", () => {
    const limited = { ...base, billingReadyUnapproved: null, uncoveredShifts: null, documentsBlocking: null, documentsToReview: null };
    expect(actionNeededTotal(limited)).toBe(1 + 2 + 3 + 5);
    expect(actionCategories(limited).map((c) => c.key)).not.toContain("readyForApproval");
  });

  it("the 12 + 3 example: only Unfilled Shifts and Ready for Approval, everything else zero", () => {
    const a = { ...base, missingTimeOut: 0, notConfirmed: 0, needsReview: 0, lateResponsesToReview: 0, documentsBlocking: 0, documentsToReview: 0, uncoveredShifts: 12, billingReadyUnapproved: 3, documentsExpiring: 1 };
    expect(actionNeededTotal(a)).toBe(15);
  });

  it("reminders are Waiting for a Signature and Documents Expiring Soon only, listed when non-zero", () => {
    expect(reminders(base).map((r) => [r.label, r.count])).toEqual([["Waiting for a Signature", 20], ["Documents Expiring Soon", 30]]);
    expect(reminders({ ...base, awaitingSignature: 0, documentsExpiring: null })).toEqual([]);
  });
});

describe("actionNeededState", () => {
  it("red above zero, green only for a confirmed zero, neutral when loading, failed or missing", () => {
    expect(actionNeededState(false, false, base).kind).toBe("attention");
    expect(actionNeededState(false, false, { ...base, missingTimeOut: 0, notConfirmed: 0, needsReview: 0, billingReadyUnapproved: 0, lateResponsesToReview: 0, uncoveredShifts: 0, documentsBlocking: 0, documentsToReview: 0 }).kind).toBe("clear");
    expect(actionNeededState(true, false, undefined)).toMatchObject({ kind: "checking", count: null });
    expect(actionNeededState(false, true, base)).toMatchObject({ kind: "unknown", count: null });
    expect(actionNeededState(false, false, null)).toMatchObject({ kind: "unknown", count: null });
  });
});
