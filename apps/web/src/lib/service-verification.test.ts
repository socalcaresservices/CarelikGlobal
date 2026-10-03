import { describe, expect, it } from "vitest";
import { formatElapsed, formatHours, formatScheduledWindow, UNLINKED_VISIT_LABEL } from "./service-verification";

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
