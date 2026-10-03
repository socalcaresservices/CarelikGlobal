import { describe, expect, it } from "vitest";
import { classifyIncompleteVisit, formatElapsed, formatHours, formatScheduledWindow, UNLINKED_VISIT_LABEL } from "./service-verification";

describe("formatHours", () => {
  it("formats exact minutes as decimal hours, dropping a trailing .00", () => {
    expect(formatHours(60)).toBe("1");
    expect(formatHours(90)).toBe("1.50");
    expect(formatHours(105)).toBe("1.75");
  });

  it("formats zero minutes as 0", () => {
    expect(formatHours(0)).toBe("0");
  });
});

describe("formatElapsed", () => {
  it("formats under an hour as mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(599)).toBe("9:59");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatElapsed(3661)).toBe("1:01:01");
    expect(formatElapsed(3600)).toBe("1:00:00");
  });

  it("never returns a negative duration", () => {
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("formatScheduledWindow", () => {
  it("formats a linked shift's window in Pacific time", () => {
    expect(
      formatScheduledWindow("2026-08-24T21:30:00.000Z", "2026-08-24T23:30:00.000Z")
    ).toMatch(/^2:30\sPM–4:30\sPM$/);
  });

  it("says the visit is not linked when there is no shift", () => {
    expect(formatScheduledWindow(null, null)).toBe(UNLINKED_VISIT_LABEL);
    expect(formatScheduledWindow("2026-08-24T21:30:00.000Z", null)).toBe(UNLINKED_VISIT_LABEL);
  });
});

describe("classifyIncompleteVisit", () => {
  const now = new Date("2026-10-03T20:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it("does not flag a visit still inside its scheduled shift", () => {
    expect(
      classifyIncompleteVisit({ status: "draft", time_in: ago(60), time_out: null, scheduled_ends_at: ago(-30) }, now)
    ).toBeNull();
  });

  it("flags a missing Time Out once the scheduled shift has ended", () => {
    expect(
      classifyIncompleteVisit({ status: "draft", time_in: ago(300), time_out: null, scheduled_ends_at: ago(45) }, now)
    ).toEqual({ kind: "missing_time_out", reason: "past_scheduled_end", minutesOverdue: 45 });
  });

  it("flags an unscheduled open visit only after 12 hours", () => {
    expect(classifyIncompleteVisit({ status: "draft", time_in: ago(11 * 60), time_out: null }, now)).toBeNull();
    expect(classifyIncompleteVisit({ status: "draft", time_in: ago(13 * 60), time_out: null }, now)).toEqual({
      kind: "missing_time_out",
      reason: "open_without_schedule",
      minutesOverdue: 60,
    });
  });

  it("flags an ended visit left unconfirmed for an hour or more", () => {
    expect(classifyIncompleteVisit({ status: "awaiting_signature", time_in: ago(200), time_out: ago(30) }, now)).toBeNull();
    expect(classifyIncompleteVisit({ status: "awaiting_signature", time_in: ago(200), time_out: ago(90) }, now)).toEqual({
      kind: "not_confirmed",
      minutesSinceTimeOut: 90,
    });
  });

  it("never flags confirmed or reviewed visits", () => {
    for (const status of ["signed", "administrator_review", "corrected", "voided"]) {
      expect(classifyIncompleteVisit({ status, time_in: ago(2000), time_out: ago(1900) }, now)).toBeNull();
    }
  });
});
