import { describe, expect, it } from "vitest";
import { CHECK_GROUPS, documentStatusLabel, groupOutcome, rangeLabel, scoreLabel, timeLabel, weeklySummary, type CheckRow } from "./format";

describe("readiness words", () => {
  it("formats times and overnight ranges", () => {
    expect(timeLabel("00:00")).toBe("12:00 AM");
    expect(timeLabel("12:30")).toBe("12:30 PM");
    expect(timeLabel("20:05:00")).toBe("8:05 PM");
    expect(timeLabel("nonsense")).toBe("nonsense");
    expect(rangeLabel({ start_local: "22:00", end_local: "06:00" })).toBe("10:00 PM – 6:00 AM (next day)");
    expect(rangeLabel({ start_local: "08:00", end_local: "20:00" })).toBe("8:00 AM – 8:00 PM");
  });

  it("shows every day, including days with no hours", () => {
    const s = weeklySummary([{ weekday: 1, start_local: "13:00", end_local: "17:00" }, { weekday: 1, start_local: "08:00", end_local: "12:00" }]);
    expect(s).toHaveLength(7);
    expect(s[1]!.ranges).toEqual(["8:00 AM – 12:00 PM", "1:00 PM – 5:00 PM"]);
    expect(s[0]!.ranges).toEqual([]);
  });

  it("maps document codes to the short labels and never calls an unverified record current", () => {
    expect(documentStatusLabel("ok", "cpr")).toMatchObject({ label: "Current", ok: true });
    expect(documentStatusLabel("awaiting_review", "tb")).toMatchObject({ label: "Needs review", ok: false });
    expect(documentStatusLabel("rejected", "cpr")).toMatchObject({ label: "Unverified", ok: false });
    expect(documentStatusLabel("expired", "cpr")).toMatchObject({ label: "Expired", ok: false });
    expect(documentStatusLabel("missing", "tb")).toMatchObject({ label: "Missing", ok: false });
    expect(documentStatusLabel("policy_not_set", "tb")).toMatchObject({ label: "Setup incomplete", ok: false });
    expect(documentStatusLabel(undefined, "cpr").ok).toBe(false);
  });

  it("groups checks separately and reports a would-block as different from a block", () => {
    const row = (check: string, status: CheckRow["status"], message: string | null, enforced: boolean): CheckRow => ({ check, status, code: null, message, enforced, blocking: status === "blocked" && enforced });
    const rows = [row("availability", "blocked", "Outside approved hours.", true), row("service", "blocked", "Not approved for this service.", false), row("cpr", "ok", null, true), row("tb", "ok", null, true), row("conflict", "ok", null, true)];
    const by = Object.fromEntries(CHECK_GROUPS.map((g) => [g.key, groupOutcome(rows, g)]));
    expect(by.availability).toEqual({ state: "blocked", messages: ["Outside approved hours."] });
    expect(by.service).toEqual({ state: "would_block", messages: ["Not approved for this service."] });
    expect(by.documents!.state).toBe("ok");
    expect(by.conflicts!.state).toBe("ok");
    expect(groupOutcome([row("service", "not_checked", null, false)], CHECK_GROUPS[1]!).state).toBe("not_checked");
  });

  it("scores read 'Score incomplete' unless the server gave a complete total", () => {
    expect(scoreLabel({ complete: false, label: "Score incomplete", total: null })).toBe("Score incomplete");
    expect(scoreLabel({ complete: true, label: null, total: 75, ruleStatus: "provisional" })).toBe("75% (provisional)");
    expect(scoreLabel({ complete: true, label: null, total: 83.33333, ruleStatus: "approved" })).toBe("83.3%");
  });
});
