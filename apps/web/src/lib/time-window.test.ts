import { describe, expect, it } from "vitest";
import { windowHint, windowKind } from "./time-window";

describe("windowKind", () => {
  it("classifies same-day, overnight and invalid windows", () => {
    expect(windowKind("09:00", "13:00")).toBe("same_day");
    expect(windowKind("22:00", "06:00")).toBe("overnight");
    expect(windowKind("22:00:00", "00:00:00")).toBe("overnight");
    expect(windowKind("09:00", "09:00")).toBe("invalid");
    expect(windowKind("", "09:00")).toBe("invalid");
  });
  it("explains overnight and equal times, and says nothing for a normal window", () => {
    expect(windowHint("22:00", "06:00")).toBe("Overnight: ends the next day.");
    expect(windowHint("09:00", "09:00")).toBe("Start and end can't be the same.");
    expect(windowHint("09:00", "17:00")).toBeNull();
  });
});
