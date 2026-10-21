// Backgrounds are four different choices (Light, White, Soft gray, Dark), and the Minimal layout can only restyle: it contains no property
// that hides, clips, shrinks away or recolours content, and it leaves every element that carries a status alone.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUNDS, LAYOUTS } from "../aws/appearance/appearance";

const css = readFileSync(join(__dirname, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selectorStart: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim().startsWith(selectorStart));
const triplet = (block: string, name: string) => new RegExp(`--${name}:\\s*(\\d+ \\d+ \\d+)`).exec(block)?.[1];
const tokens = (bg: string) => {
  const root = css.match(/:root \{([^}]*)\}/)![1]!;
  const over = rule(`[data-og-bg="${bg}"]`).filter((m) => m[1]!.trim() === `[data-og-bg="${bg}"]`).map((m) => m[2]!).join("\n");
  return Object.fromEntries(["page", "card", "side", "line"].map((n) => [n, triplet(over, `og-${n}`) ?? triplet(root, `og-${n}`)]));
};

describe("backgrounds", () => {
  it("are exactly Light, White, Soft gray and Dark, and no code or stylesheet still offers Cream", () => {
    expect([...BACKGROUNDS]).toEqual(["light", "white", "gray", "dark"]);
    expect(css).not.toMatch(/cream/i);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const offenders = walk(join(__dirname, "..")).filter((f) => /\.(tsx?|css)$/.test(f) && !f.includes(".test.")).filter((f) => /["']cream["']|Warm cream/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("White is a different background from Light, and no two backgrounds share the same surface tokens", () => {
    const t = Object.fromEntries(BACKGROUNDS.map((b) => [b, tokens(b)]));
    expect(t.white).toMatchObject({ page: "255 255 255", card: "255 255 255" });
    expect(t.light!.page).not.toBe(t.white!.page);
    expect(t.light!.side).not.toBe(t.white!.side);
    expect(t.light!.line).not.toBe(t.white!.line);
    const seen = new Map<string, string>();
    for (const b of BACKGROUNDS) {
      const key = JSON.stringify(t[b]);
      expect(seen.get(key), `${b} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, b);
      for (const [name, v] of Object.entries(t[b]!)) expect(v, `${b} ${name}`).toBeTruthy();
    }
  });
});

describe("Minimal layout", () => {
  it("is one of two layouts and has stylesheet rules", () => {
    expect([...LAYOUTS]).toEqual(["standard", "minimal"]);
    expect(rule('[data-og-layout="minimal"]').length).toBeGreaterThan(0);
  });

  it("only changes borders, fill, rounding, shadow and spacing: nothing that hides, clips, shrinks or recolours content", () => {
    const allowed = new Set(["border-radius", "border-top-width", "border-left-width", "border-right-width", "border-bottom-width", "background-color", "box-shadow", "margin-top"]);
    for (const m of rule('[data-og-layout="minimal"]')) {
      for (const decl of m[2]!.split(";").map((d) => d.trim()).filter(Boolean)) {
        const prop = decl.split(":")[0]!.trim();
        expect(allowed.has(prop), `${prop} in ${m[1]!.trim().slice(0, 60)}`).toBe(true);
      }
      const props = m[2]!.split(";").map((d) => d.split(":")[0]!.trim()).filter(Boolean);
      for (const prop of props) expect(prop, prop).not.toMatch(/^(display|visibility|opacity|clip|clip-path|overflow|height|max-|min-|font|color|content|-webkit-line-clamp|line-clamp|position|transform|text-overflow|text-indent|filter)/);
      // background is only ever removed (transparent), never set to a colour that could match the text
      for (const bg of m[2]!.matchAll(/background-color:\s*([^;]+)/g)) expect(bg[1]!.trim()).toBe("transparent");
    }
  });

  it("leaves status-bearing elements alone (red, amber, emerald, sky), and form controls, buttons and images", () => {
    const selectors = rule('[data-og-layout="minimal"] main').map((m) => m[1]!).join(" ");
    for (const s of ['border-red', 'border-amber', 'bg-red', 'bg-amber', 'bg-emerald', 'bg-sky', "input", "select", "textarea", "button", "img"]) expect(selectors).toContain(s);
  });
});
