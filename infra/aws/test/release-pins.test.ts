// release_pins.py: the pins for the TEST release match this checkout, and any drift is refused. Local git and file hashes only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/", import.meta.url));
const script = join(dir, "release_pins.py");
const run = (...args: string[]) => spawnSync("python3", [script, ...args], { encoding: "utf8" });
// The application commit the pins are validated against. Changed deliberately (2026-11-21) from 88426e8 (the release deployed to production as ef90a2a) to the web follow-up
// the web follow-ups and minimal Offices (caregiver header without the staff ID; charts follow the Dashboard palette; offices, migration 0110, switch off). Any later application change must re-pin and update this line.
const PINNED = "1386e73e90ba9a4cbe26d91e645b68789fbbb666";
const present = spawnSync("git", ["cat-file", "-e", `${PINNED}^{commit}`]).status === 0;

describe.skipIf(!present)("release_pins.py", () => {
  it("the committed pins match this checkout (application files unchanged since the pinned commit; all hashes equal)", () => {
    const r = run("check", "--allow-dirty");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PINS OK");
    const pins = JSON.parse(readFileSync(join(dir, "PINS_0109.json"), "utf8"));
    expect(pins.applicationCommit).toBe(PINNED);
    expect(pins.apiRoutes).toEqual({ switchOff: 259, switchOn: 262 });   // equal to the CDK synthesis result for the isolated TEST configuration
    expect(pins.expectedLedger).toEqual({ before: "107/0107", after: "108/0109" });
    expect(pins.releasedMigrations.count).toBe(88);
  });

  it("does not count a change to a test file as an application change, but still counts any other application change", () => {
    const changed = spawnSync("git", ["diff", "--name-only", PINNED, "HEAD", "--", "apps", "packages"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    expect(changed.every((f) => /\.test\.tsx?$/.test(f))).toBe(true);   // today every change under apps and packages since the pin is a test file
    const r = run("check", "--allow-dirty");
    expect(r.status, r.stdout).toBe(0);
  });

  it("refuses a pin file whose hashes, counts or commit were altered", () => {
    const d = mkdtempSync(join(tmpdir(), "pins-"));
    try {
      const pins = JSON.parse(readFileSync(join(dir, "PINS_0109.json"), "utf8"));
      const attempt = (edit: (p: any) => void, expectText: RegExp) => {
        const copy = structuredClone(pins); edit(copy);
        const f = join(d, "p.json"); writeFileSync(f, JSON.stringify(copy));
        const r = run("check", "--allow-dirty", "--pins", f);
        expect(r.status).toBe(1); expect(r.stdout).toMatch(expectText);
      };
      attempt((p) => { p.migration0109.upSha256 = "0".repeat(64); }, /migration0109 differs/);
      attempt((p) => { p.toolchainSha256["TEST_0109_LEDGER.sh"] = "0".repeat(64); }, /toolchainSha256 differs/);
      attempt((p) => { p.pnpmLockSha256 = "0".repeat(64); }, /pnpmLockSha256 differs/);
      attempt((p) => { p.apiRoutes.switchOn = 263; }, /apiRoutes differs/);
      attempt((p) => { p.releasedMigrations.setSha256 = "0".repeat(64); }, /releasedMigrations differs/);
      attempt((p) => { p.applicationCommit = "0".repeat(40); }, /not in this checkout/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("PINS_0110.json (the Offices TEST release) matches this checkout and refuses altered hashes", () => {
    const r = run("check", "--allow-dirty", "--pins", join(dir, "PINS_0110.json"));
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout).toContain("PINS OK");
    const pins = JSON.parse(readFileSync(join(dir, "PINS_0110.json"), "utf8"));
    expect(pins.applicationCommit).toBe(PINNED);
    expect(pins.expectedLedger).toEqual({ before: "108/0109", after: "109/0110" });
    expect(pins.apiRoutes).toEqual({ switchOff: 259, switchOn: 262, officesRoutes: 6 });
    const d = mkdtempSync(join(tmpdir(), "pins0110-"));
    try {
      for (const [edit, re] of [
        [(q: any) => { q.migration0110.upSha256 = "0".repeat(64); }, /migration0110 differs/],
        [(q: any) => { q.toolchainSha256["TEST_H3_OFFICES.sh"] = "0".repeat(64); }, /toolchainSha256 differs/],
        [(q: any) => { q.apiRoutes.officesRoutes = 7; }, /apiRoutes differs/],
        [(q: any) => { q.expectedLedger.after = "108/0109"; }, /expectedLedger differs/],
      ] as const) {
        const copy = structuredClone(pins); edit(copy); const f = join(d, "p.json"); writeFileSync(f, JSON.stringify(copy));
        const x = run("check", "--allow-dirty", "--pins", f); expect(x.status).toBe(1); expect(x.stdout).toMatch(re);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses when application files changed since the pinned commit (the older accepted TEST source)", () => {
    const d = mkdtempSync(join(tmpdir(), "pins-old-"));
    try {
      const f = join(d, "old.json");
      const gen = run("generate", "--app-commit", "6cbab00", "--out", f);
      expect(gen.status, gen.stderr).toBe(0);
      const r = run("check", "--allow-dirty", "--pins", f);
      expect(r.status).toBe(1); expect(r.stdout).toContain("application files changed since the pinned commit");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
