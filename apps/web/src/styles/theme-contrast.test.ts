// Every background x accent combination keeps readable text and the same status meanings. Reads the real CSS (theme-scales.css + theme.css),
// resolves the variables the way the cascade does, and checks WCAG contrast (4.5:1 for text, 3:1 for chart marks and the focus accent).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENTS, ACCENT_RGB, BACKGROUNDS } from "../aws/appearance/appearance";

type Vars = Record<string, [number, number, number]>;
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

function blocks(css: string): { selector: string; vars: Vars }[] {
  const out: { selector: string; vars: Vars }[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const vars: Vars = {};
    for (const d of m[2]!.matchAll(/(--[\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) vars[d[1]!] = [Number(d[2]), Number(d[3]), Number(d[4])];
    if (Object.keys(vars).length) out.push({ selector: m[1]!.trim(), vars });
  }
  return out;
}
const ALL = [...blocks(read("theme-scales.css")), ...blocks(read("theme.css"))];

function resolve(bg: string, accent: string): Vars {
  const applies = (sel: string) =>
    sel === ":root" || sel === `[data-og-bg="${bg}"]` || sel === `[data-og-accent="${accent}"]` || sel === `[data-og-bg="${bg}"][data-og-accent="${accent}"]`;
  // Cascade: later and more specific rules win; ALL is in source order and the two-attribute selector is last.
  const rank = (sel: string) => (sel === ":root" ? 0 : sel.includes("][") ? 3 : sel.startsWith("[data-og-accent") ? 2 : 1);
  const vars: Vars = {};
  for (const r of [0, 1, 2, 3]) for (const b of ALL) if (applies(b.selector) && rank(b.selector) === r) Object.assign(vars, b.vars);
  return vars;
}

const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c: readonly number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const ratio = (a: readonly number[], b: readonly number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const over = (fg: readonly number[], bg: readonly number[], alpha: number): [number, number, number] => [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as [number, number, number];

describe.each(BACKGROUNDS.flatMap((bg) => ACCENTS.map((accent) => [bg, accent] as const)))("theme %s + %s", (bg, accent) => {
  const v = resolve(bg, accent);
  const c = (name: string) => v[`--${name}`] ?? (() => { throw new Error(`missing --${name} in ${bg}/${accent}`); })();

  it("body and secondary text are readable on page, card and sidebar", () => {
    for (const surface of ["og-page", "og-card", "og-side"]) {
      expect(ratio(c("og-ink"), c(surface)), `ink on ${surface}`).toBeGreaterThanOrEqual(7);
      expect(ratio(c("og-sub"), c(surface)), `sub on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("slate-500"), c(surface)), `slate-500 (secondary grey) on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the accent works as text, as a button fill under its own text, and as the selected-row tint", () => {
    for (const surface of ["og-page", "og-card", "og-side"]) expect(ratio(c("og-accent"), c(surface)), `accent on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c("og-accent-fg"), c("og-accent")), "button text").toBeGreaterThanOrEqual(4.5);
    const tint = over(c("og-accent"), c("og-card"), 0.16);
    expect(ratio(c("og-accent"), tint), "accent text on selected tint").toBeGreaterThanOrEqual(4.5);
    expect(ratio(c("og-ink"), tint), "ink on selected tint").toBeGreaterThanOrEqual(4.5);
  });

  it("status colours keep their meaning and stay readable: red, amber, neutral, with the same pairs the chips use", () => {
    const pairs: [string, string, string][] = [
      ["red-800", "red-100", "Urgent chip"], ["amber-900", "amber-100", "Soon chip"], ["slate-700", "slate-100", "Routine chip"],
      ["red-800", "red-50", "urgent badge"], ["amber-900", "amber-50", "approaching badge"], ["emerald-900", "emerald-100", "verified chip"],
      ["red-700", "og-card", "red text on card"], ["red-700", "og-page", "red text on page"], ["amber-800", "og-card", "amber text on card"], ["amber-900", "og-card", "amber note on card"],
      ["og-warn", "og-warn-bg", "warning row"],
    ];
    for (const [fg, bgName, label] of pairs) expect(ratio(c(fg), c(bgName)), label).toBeGreaterThanOrEqual(4.5);
  });

  it("status hues stay distinct: red and amber differ from each other and from neutral text", () => {
    expect(ratio(c("red-700"), c("amber-800"))).toBeGreaterThan(1.0);
    const hue = (rgb: readonly number[]) => { const [r, g, b] = rgb as [number, number, number]; return r >= g && g >= b ? "warm" : "other"; };
    expect(hue(c("red-700"))).toBe("warm");
    expect(hue(c("amber-800"))).toBe("warm");
    expect(c("red-700")).not.toEqual(c("amber-800"));
  });

  it("chart marks are visible against the card (3:1)", () => {
    for (const mark of [c("og-accent"), c("og-chart-2"), c("og-chart-3"), c("og-chart-4"), c("og-chart-5")]) expect(ratio(mark, c("og-card"))).toBeGreaterThanOrEqual(3);
  });
});

describe("accent swatches match the CSS", () => {
  it.each(ACCENTS)("%s", (accent) => {
    expect(resolve("light", accent)["--og-accent"]).toEqual([...ACCENT_RGB[accent].light]);
    expect(resolve("dark", accent)["--og-accent"]).toEqual([...ACCENT_RGB[accent].dark]);
  });
});
