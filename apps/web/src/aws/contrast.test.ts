import { describe, expect, it } from "vitest";
import { contrastWithWhite } from "./contrast";

// Same WCAG formula as ogevia.contrast_with_white (0020); 4.5:1 is the bar.
describe("contrastWithWhite", () => {
  it("passes dark accents and refuses light ones", () => {
    expect(contrastWithWhite("#1f5f8b")).toBeGreaterThanOrEqual(4.5);
    expect(contrastWithWhite("#0f172a")).toBeGreaterThan(15);
    expect(contrastWithWhite("#ffd966")).toBeLessThan(4.5);
    expect(contrastWithWhite("#ffffff")).toBe(1);
  });
});
