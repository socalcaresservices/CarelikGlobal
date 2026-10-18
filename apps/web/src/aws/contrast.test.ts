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

// Disabled Button pairs (packages/ui button.tsx) use the slate scale from theme-scales.css, which is inverted for the dark background.
// WCAG exempts disabled controls, but the owner wants at least 3:1 on every background and accent, so the pairs are fixed neutrals (never the accent).
describe("disabled button contrast", () => {
  const lum = (rgb: [number, number, number]) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const light = { s100: [241, 245, 249], s200: [226, 232, 240], s500: [87, 100, 120], s600: [71, 85, 105], white: [255, 255, 255], gray: [249, 250, 252] } as const;
  const dark = { s100: [15, 23, 42], s200: [30, 41, 59], s500: [139, 154, 175], s600: [148, 163, 184], card: [20, 30, 38] } as const;
  it.each([
    ["primary/danger light", light.s600, light.s200], ["primary/danger dark", dark.s600, dark.s200],
    ["secondary light", light.s500, light.s100], ["secondary dark", dark.s500, dark.s100],
    ["ghost on white", light.s500, light.white], ["ghost on gray", light.s500, light.gray], ["ghost on dark card", dark.s500, dark.card],
  ])("%s is at least 3:1", (_n, fg, bg) => {
    expect(ratio([...fg] as [number, number, number], [...bg] as [number, number, number])).toBeGreaterThanOrEqual(3);
  });
});
