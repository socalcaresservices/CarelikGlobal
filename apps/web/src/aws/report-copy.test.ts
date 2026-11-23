// The Reports screens show data, not explanations (owner direction 2026-10-25). Definitions and "how this is calculated" notes live behind the compact Help
// control (InfoTip). Errors, empty states, validation messages and real warnings stay visible. This is a floor like copy-length.test.ts: it sees literal paragraphs only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = ["src/pages/service-verification-reports-page.tsx", "src/aws/reporting-page.tsx", "src/aws/monthly-chain-report.tsx"];
const MAX = 120;
// Visible on purpose: a warning that the signed record is never overwritten, and the void-visit warning (an action that cannot be undone).
const KEEP = [/^The signed record is never overwritten/, /^Use this only when the visit never happened/, /^You don.t have permission/, /^No /, /^Could not load/, /^The audit report could not be loaded/, /^A check on the full-chain report/];

describe("report screens carry no explanatory paragraphs", () => {
  it(`no visible literal paragraph over ${MAX} characters, except warnings, empty states and errors`, () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/<p\b[^>]*>\s*([^<{][^<{]*?)\s*<\/p>/g)) {
        const text = m[1]!.replace(/\s+/g, " ").trim();
        if (text.length > MAX && !KEEP.some((k) => k.test(text))) offenders.push(`${f}: ${text.slice(0, 80)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the definitions that were removed from view are still available in the page behind Help controls", () => {
    for (const phrase of ["Utilization is committed time", "Shifts are counted by their start date", "Each row is one client + service + authorization lineage", "Billable” means eligible to bill"]) {
      const hit = FILES.map((f) => readFileSync(join(process.cwd(), f), "utf8")).find((s) => s.includes(phrase));
      expect(hit, phrase).toBeDefined();
      const i = hit!.indexOf(phrase);
      expect(hit!.slice(Math.max(0, i - 300), i), phrase).toContain("<InfoTip");
    }
  });
});
