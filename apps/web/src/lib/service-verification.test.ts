import { describe, expect, it } from "vitest";
import { formatElapsed, formatHours } from "./service-verification";

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
