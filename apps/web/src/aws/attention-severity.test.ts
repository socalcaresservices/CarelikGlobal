// Severity vocabulary (Board 4 D7/D8): Critical / Urgent / Routine. An uncovered shift is Critical once it has started, Urgent inside the
// 48-hour window, and Upcoming (not urgent) beyond it. SYNTHETIC data only.
import { describe, expect, it } from "vitest";
import { coverageTone, freshness, itemTone, rankedItems, REFRESH_MS, STALE_AFTER_MS, streams, TONE, urgentBadge, type AttentionOverview, type UrgentItem } from "./attention";

const AS_OF = "2026-10-18T12:00:00Z";
const NOW = Date.parse(AS_OF);
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const item = (over: Partial<UrgentItem> = {}): UrgentItem => ({
  kind: "shift", id: "s1", startsAt: hoursFromNow(5), endsAt: hoursFromNow(8), reasons: ["uncovered_open"], severity: "red", inProgress: false,
  caregiverRecordId: null, caregiverCode: null, clientCode: "C-AAA111", serviceCode: "RSP", ...over,
});
const overview = (over: Partial<AttentionOverview> = {}): AttentionOverview => ({
  asOf: AS_OF, urgentWindowHours: 48,
  urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0 },
  upcoming: { count: 0, nextStartsAt: null, shifts: [] }, documents: null, visitReview: null, ...over,
});

describe("the vocabulary", () => {
  it("is Critical / Urgent / Routine; the old word Soon is gone", () => {
    expect(TONE.red.word).toBe("Critical");
    expect(TONE.amber.word).toBe("Urgent");
    expect(TONE.neutral.word).toBe("Routine");
    expect(Object.values(TONE).map((t) => t.word)).not.toContain("Soon");
  });
  it("every tone keeps a distinct symbol, so colour is never the only signal", () => {
    expect(new Set(Object.values(TONE).map((t) => t.icon)).size).toBe(3);
  });
});

describe("coverage severity", () => {
  it("is Critical from the start time onward and Urgent before it", () => {
    expect(coverageTone(hoursFromNow(-0.01), NOW)).toBe("red");
    expect(coverageTone(hoursFromNow(0), NOW)).toBe("red");
    expect(coverageTone(hoursFromNow(0.01), NOW)).toBe("amber");
    expect(coverageTone(hoursFromNow(47.9), NOW)).toBe("amber");
  });
  it("applies to a shift whose only problem is that nobody is covering it, called out or never assigned", () => {
    expect(itemTone(item({ startsAt: hoursFromNow(-2), reasons: ["uncovered_called_out"] }), NOW)).toBe("red");
    expect(itemTone(item({ startsAt: hoursFromNow(30), reasons: ["uncovered_open"] }), NOW)).toBe("amber");
  });
  it("leaves other items on the server's severity (a hold or document problem on a shift, a visit open too long)", () => {
    expect(itemTone(item({ startsAt: hoursFromNow(30), reasons: ["compliance_hold"], severity: "red" }), NOW)).toBe("red");
    expect(itemTone(item({ startsAt: hoursFromNow(30), reasons: ["uncovered_open", "compliance_hold"], severity: "red" }), NOW)).toBe("red");
    expect(itemTone(item({ kind: "visit", reasons: ["missing_clock_out"], severity: "amber", startsAt: hoursFromNow(-5) }), NOW)).toBe("amber");
    expect(itemTone(item({ kind: "visit", reasons: ["in_progress_on_hold"], severity: "red", startsAt: hoursFromNow(-1) }), NOW)).toBe("red");
  });
  it("uses the server's asOf, never the browser clock", () => {
    const o = overview({ urgent: { items: [item({ startsAt: hoursFromNow(1) })], itemCount: 1, issueCount: 1, shifts: 1, visits: 0 } });
    const badge = urgentBadge(false, false, o);
    expect(badge.kind === "urgent" && badge.tone).toBe("amber");
  });
});

describe("ordering", () => {
  it("lists Critical first, then Urgent, soonest first inside a tier, with a stable tie-break", () => {
    const list = [
      item({ id: "c", startsAt: hoursFromNow(10) }),
      item({ id: "b", startsAt: hoursFromNow(-1) }),
      item({ id: "a", startsAt: hoursFromNow(-3) }),
      item({ id: "d", startsAt: hoursFromNow(10) }),
    ];
    expect(rankedItems(list, NOW).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("does not change the input", () => {
    const list = [item({ id: "b", startsAt: hoursFromNow(5) }), item({ id: "a", startsAt: hoursFromNow(-5) })];
    rankedItems(list, NOW);
    expect(list.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("tiles", () => {
  it("the tile is Critical when any item has started, Urgent when none has, neutral when empty", () => {
    const tone = (items: UrgentItem[]) => streams(overview({ urgent: { items, itemCount: items.length, issueCount: items.length, shifts: items.length, visits: 0 } })).find((s) => s.key === "now")!.tone;
    expect(tone([item({ startsAt: hoursFromNow(-1) })])).toBe("red");
    expect(tone([item({ startsAt: hoursFromNow(4) })])).toBe("amber");
    expect(tone([])).toBe("neutral");
  });
  it("Upcoming staffing is never urgent, however close to the window: it is shifts beyond 48 hours", () => {
    const tile = streams(overview({ upcoming: { count: 3, nextStartsAt: hoursFromNow(49), shifts: [] } })).find((s) => s.key === "staffing")!;
    expect(tile.tone).toBe("neutral");
    expect(tile.count).toBe(3);
  });
});

describe("freshness", () => {
  it("is fresh within twice the refresh interval, stale after, and says why when a refresh failed", () => {
    const o = overview();
    expect(freshness(false, false, o, NOW + 1000).kind).toBe("fresh");
    expect(freshness(false, false, o, NOW + STALE_AFTER_MS + 1)).toEqual({ kind: "stale", asOf: AS_OF, reason: "old" });
    expect(freshness(false, true, o, NOW + 1000)).toEqual({ kind: "stale", asOf: AS_OF, reason: "refresh_failed" });
    expect(STALE_AFTER_MS).toBe(2 * REFRESH_MS);
  });
  it("without data it is loading, or unavailable after a failure; never fresh, never zero", () => {
    expect(freshness(true, false, undefined, NOW).kind).toBe("loading");
    expect(freshness(false, true, undefined, NOW).kind).toBe("unavailable");
    expect(freshness(false, false, undefined, NOW).kind).toBe("unavailable");
  });
});

describe("queues that stay apart (0058)", () => {
  const docs = (over: object) => overview({ documents: { overdue: 0, dueSoon: 0, awaitingReview: 0, reviewRoutine: 0, reviewOverdue: 0, rejected: 0, caregiversOnHold: 0, caregiversWithPendingRequirements: 0, ...over } });
  const visits = (over: object) => overview({ visitReview: { visitsNeedingAttention: 0, pendingConfirmation: 0, confirmationOverdue: 0, awaitingConfirmation: 0, needsReview: 0, reviewOverdue: 0, lateResponses: 0, readyForApproval: 0, reviewIssues: 0, awaitingResponse: 0, ...over } });
  const tile = (o: AttentionOverview, key: string) => streams(o).find((s) => s.key === key)!;

  it("routine document review is shown but never counted; overdue documents are labelled Overdue, not Urgent", () => {
    const routine = tile(docs({ awaitingReview: 3, reviewRoutine: 3 }), "documents");
    expect(routine.count).toBe(0);
    expect(routine.tone).toBe("neutral");
    expect(routine.detail).toContain("3 awaiting routine review");
    const overdue = tile(docs({ overdue: 2, awaitingReview: 4, reviewRoutine: 3, reviewOverdue: 1 }), "documents");
    expect(overdue.count).toBe(3); // 2 overdue + 1 escalated review; the 3 routine reviews are not added
    expect(overdue.word).toBe("Overdue");
    expect(overdue.word).not.toBe("Urgent");
  });
  it("a caregiver on hold counts, with its own words, and a rejected document needs action", () => {
    expect(tile(docs({ caregiversOnHold: 1 }), "documents")).toMatchObject({ count: 1, word: "Needs action", tone: "amber" });
    expect(tile(docs({ rejected: 2 }), "documents").count).toBe(2);
  });
  it("pending confirmation and ready for approval are routine: in the detail, never in the count", () => {
    const t = tile(visits({ visitsNeedingAttention: 0, pendingConfirmation: 4, readyForApproval: 6 }), "visits");
    expect(t.count).toBe(0);
    expect(t.tone).toBe("neutral");
    expect(t.detail).toBe("Nothing needs a decision now. · 4 pending confirmation · 6 ready for approval");
  });
  it("review waiting 24 h is Urgent; a confirmation overdue at 48 h is Overdue; neither is called Critical", () => {
    expect(tile(visits({ visitsNeedingAttention: 2, needsReview: 2, reviewOverdue: 1 }), "visits")).toMatchObject({ count: 2, tone: "amber", word: "Urgent" });
    expect(tile(visits({ visitsNeedingAttention: 1, confirmationOverdue: 1, awaitingConfirmation: 1 }), "visits")).toMatchObject({ count: 1, tone: "amber", word: "Overdue" });
    expect(tile(visits({ visitsNeedingAttention: 1, needsReview: 1 }), "visits").word).toBeUndefined();
  });
  it("an older server without the new fields still gives sensible tiles", () => {
    const old = overview({ documents: { overdue: 1, dueSoon: 0, awaitingReview: 2, rejected: 0, caregiversOnHold: 0 }, visitReview: { visitsNeedingAttention: 3, awaitingConfirmation: 1, needsReview: 2, lateResponses: 0, readyForApproval: null, reviewIssues: 2, awaitingResponse: 0 } });
    expect(tile(old, "documents").count).toBe(1);
    expect(tile(old, "visits").count).toBe(3);
  });
  it("Upcoming staffing counts blocked shifts too, and says what it lists", () => {
    const t = tile(overview({ upcoming: { count: 2, nextStartsAt: hoursFromNow(60), shifts: [] } }), "staffing");
    expect(t).toMatchObject({ count: 2, unit: "shifts", tone: "neutral" });
    expect(t.detail).toContain("Uncovered or blocked");
  });
});

describe("the server's tier wins over the old severity", () => {
  it("tier critical is red and urgent is amber whatever the legacy field says", () => {
    expect(itemTone(item({ tier: "critical", severity: "amber" }), NOW)).toBe("red");
    expect(itemTone(item({ tier: "urgent", severity: "red", startsAt: hoursFromNow(-3) }), NOW)).toBe("amber");
  });
});
