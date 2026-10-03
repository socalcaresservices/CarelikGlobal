import { describe, expect, it } from "vitest";
import {
  classifyIncompleteVisit,
  formatElapsed,
  formatHours,
  formatScheduledWindow,
  pacificWallTimeToDate,
  toPacificWallTime,
  UNLINKED_VISIT_LABEL,
  validateManagerTimeOut,
} from "./service-verification";

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

describe("Pacific Time Out entry", () => {
  const timeIn = "2026-10-03T16:02:00.000Z"; // Oct 3, 9:02 AM PDT
  const now = new Date("2026-10-04T05:00:00.000Z"); // Oct 3, 10:00 PM PDT

  it("pre-fills the Pacific date, 12-hour clock and AM/PM", () => {
    expect(toPacificWallTime(timeIn)).toEqual({ date: "2026-10-03", hour: 9, minute: 2, meridiem: "AM" });
    expect(toPacificWallTime("2026-10-03T19:00:00.000Z")).toEqual({ date: "2026-10-03", hour: 12, minute: 0, meridiem: "PM" });
    expect(toPacificWallTime("2026-10-03T07:30:00.000Z")).toEqual({ date: "2026-10-03", hour: 12, minute: 30, meridiem: "AM" });
  });

  it("converts Pacific entries to the right instant in daylight and standard time", () => {
    const pdt = pacificWallTimeToDate({ date: "2026-10-03", hour: 1, minute: 15, meridiem: "PM" });
    expect(pdt).toEqual({ ok: true, value: new Date("2026-10-03T20:15:00.000Z") });
    const pst = pacificWallTimeToDate({ date: "2026-12-01", hour: 12, minute: 0, meridiem: "AM" });
    expect(pst).toEqual({ ok: true, value: new Date("2026-12-01T08:00:00.000Z") });
    for (const value of ["2026-10-03T20:15:00.000Z", "2026-03-08T10:30:00.000Z", "2026-11-01T10:30:00.000Z"]) {
      const back = pacificWallTimeToDate(toPacificWallTime(value));
      expect(back.ok && back.value.toISOString()).toBe(value);
    }
    // 1:30 AM happens twice on the fall-back date; the entry means the first (PDT) one.
    const repeated = pacificWallTimeToDate({ date: "2026-11-01", hour: 1, minute: 30, meridiem: "AM" });
    expect(repeated.ok && repeated.value.toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("names what is missing or impossible", () => {
    expect(pacificWallTimeToDate({ date: "", hour: 1, minute: 0, meridiem: "PM" })).toEqual({ ok: false, error: "Enter the date the visit ended." });
    expect(pacificWallTimeToDate({ date: "2026-10-03", hour: 1, minute: 0, meridiem: null })).toEqual({ ok: false, error: "Choose the hour, minute, and AM or PM." });
    // 2:30 AM does not exist on the spring-forward date.
    const gap = pacificWallTimeToDate({ date: "2026-03-08", hour: 2, minute: 30, meridiem: "AM" });
    expect(gap.ok).toBe(false);
  });

  it("mirrors the server's Time Out limits with specific messages", () => {
    expect(validateManagerTimeOut(timeIn, new Date("2026-10-03T20:15:00.000Z"), now)).toBeNull();
    expect(validateManagerTimeOut(timeIn, new Date("2026-10-03T08:15:00.000Z"), now)).toBe(
      "Time Out (Oct 3, 2026, 1:15 AM) must be after Time In (Oct 3, 2026, 9:02 AM). Check the date and AM/PM.",
    );
    expect(validateManagerTimeOut(timeIn, new Date("2026-10-04T08:15:00.000Z"), now)).toMatch(/is in the future/);
    expect(
      validateManagerTimeOut(timeIn, new Date("2026-10-04T17:00:00.000Z"), new Date("2026-10-05T00:00:00.000Z")),
    ).toBe("This would make the visit 24 hr 58 min. A visit cannot be longer than 24 hours. Check the date.");
  });
});
