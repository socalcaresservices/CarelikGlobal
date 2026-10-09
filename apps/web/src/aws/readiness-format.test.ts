import { describe, expect, it } from "vitest";
import { describeWindows } from "./availability-format";
import { componentNote, distanceLabel, minutesLabel, percent, scoreLabel, type MatchComponent } from "./readiness-format";

const comp = (over: Partial<MatchComponent>): MatchComponent => ({ key: "location", status: "known", value: 0.5, weight: 0.25, points: 12.5, detail: {}, source: {}, ...over });

describe("readiness display helpers", () => {
  it("shows Incomplete, never a number, when an applicable input is unknown", () => {
    expect(scoreLabel({ score: null, scoreStatus: "incomplete" })).toBe("Incomplete");
    expect(scoreLabel({ score: 0, scoreStatus: "complete" })).toBe("0");
    expect(scoreLabel({ score: 82, scoreStatus: "complete" })).toBe("82");
  });
  it("labels distance as approximate and unknown distance as not available (never zero)", () => {
    expect(distanceLabel(null)).toBe("Not available");
    expect(distanceLabel(4.24)).toBe("~4.2 mi");
    expect(distanceLabel(12.6)).toBe("~13 mi");
  });
  it("explains why a part has no value", () => {
    expect(componentNote(comp({ status: "not_applicable" }))).toMatch(/Off/);
    expect(componentNote(comp({ status: "unknown", detail: { caregiverLocation: "not recorded", clientLocation: "recorded" } }))).toBe("ZIP not recorded (caregiver)");
    expect(componentNote(comp({ status: "unknown", detail: { caregiverLocation: "recorded", clientLocation: "recorded", coordinates: "not available for this ZIP" } }))).toBe("ZIP not in the distance list");
    expect(componentNote(comp({ key: "experience", status: "unknown" }))).toBe("Experience not reviewed yet");
    expect(componentNote(comp({ key: "experience", status: "not_applicable" }))).toMatch(/Not requested/);
  });
  it("formats percentages and minutes", () => {
    expect(percent(null)).toBe("—");
    expect(percent(0.756)).toBe("76%");
    expect(minutesLabel(150)).toBe("2 hr 30 min");
    expect(minutesLabel(120)).toBe("2 hr");
    expect(minutesLabel(45)).toBe("45 min");
  });
  it("describes availability windows, grouping days with the same hours and marking overnight", () => {
    expect(describeWindows([
      { weekday: 1, specificDate: null, startLocal: "08:00", endLocal: "17:00" },
      { weekday: 3, specificDate: null, startLocal: "08:00", endLocal: "17:00" },
      { weekday: 6, specificDate: null, startLocal: "22:00", endLocal: "06:00" },
      { weekday: null, specificDate: "2026-12-24", startLocal: "09:00", endLocal: "13:30" },
    ])).toEqual(["Mon, Wed 8 AM–5 PM", "Sat 10 PM–6 AM (overnight)", "2026-12-24 9 AM–1:30 PM"]);
    expect(describeWindows([])).toEqual([]);
  });
});
