// Recurring shifts (0034): monthly summary of a server preview. SYNTHETIC data only.
import { describe, expect, it } from "vitest";
import { patternText, summarizeOccurrences, type Occurrence } from "./recurring-format";

const occ = (d: string, outcome: Occurrence["outcome"], extra: Partial<Occurrence> = {}): Occurrence => ({
  localDate: d, startsAt: `${d}T16:00:00Z`, endsAt: `${d}T18:00:00Z`, minutes: 120, monthStart: `${d.slice(0, 7)}-01`,
  authorizationLineageId: "L1", authorizedMinutes: 1800, usedMinutes: 60, reservedMinutes: 0, seriesMinutesBefore: 0, outcome, ...extra,
});

describe("summarizeOccurrences", () => {
  it("per month: authorized, used, already reserved, this series, available after; flagged dates kept with their reason", () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => occ(`2026-11-${String(i + 2).padStart(2, "0")}`, "ok")),
      occ("2026-11-27", "exceeds_authorization"),
      occ("2026-12-01", "no_authorization", { authorizationLineageId: null, authorizedMinutes: null, usedMinutes: null, reservedMinutes: null }),
    ];
    const [nov, dec] = summarizeOccurrences(rows);
    expect(nov).toMatchObject({ monthStart: "2026-11-01", authorized: 1800, used: 60, reserved: 0, fits: 14, fitsMinutes: 1680, availableAfter: 60 });
    expect(nov!.flagged.map((f) => f.localDate)).toEqual(["2026-11-27"]);
    expect(dec).toMatchObject({ authorized: null, fits: 0, availableAfter: null });
    expect(dec!.flagged[0]!.outcome).toBe("no_authorization");
  });

  it("describes the pattern in plain words with AM/PM", () => {
    expect(patternText([1, 3, 5], "09:00:00", "11:00:00")).toBe("Every Mon, Wed, Fri · 9:00 AM–11:00 AM");
  });
});
