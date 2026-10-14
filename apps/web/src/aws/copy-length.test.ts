// Guards the plain-language rule (owner decision D7, 2026-10-14): a visible paragraph in the AWS screens stays short.
// Longer background goes behind "Details" (see help-text.tsx). A plain <p>text</p> over the limit fails this test.
// This is a floor, not a full audit: it only sees literal paragraphs, not text built in code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAX = 220;
const dir = join(process.cwd(), "src", "aws") + "/";
const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));

describe("screen copy", () => {
  it(`no literal paragraph in the AWS screens is longer than ${MAX} characters`, () => {
    const tooLong: string[] = [];
    for (const f of files(dir).filter((x) => x.endsWith(".tsx") && !x.includes(".test."))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<p[^>]*>\s*([^<{][^<{]*?)\s*<\/p>/g)) {
        const text = m[1]!.replace(/\s+/g, " ").trim();
        if (text.length > MAX) tooLong.push(`${f.slice(dir.length)}: ${text.length} chars: ${text.slice(0, 70)}…`);
      }
    }
    expect(tooLong).toEqual([]);
  });
});
