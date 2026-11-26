// SAVE_ROLLBACK_REFS.sh: copies the rollback captures somewhere durable, verifies them, never overwrites, never touches AWS, and writes an index with the right rollback commands.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/SAVE_ROLLBACK_REFS.sh", import.meta.url));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "refs-")); const work = join(dir, "work"); const dest = join(dir, "dest");
  for (const [n, snap] of [["rt2n3-20261125T195943Z", "snap-3"], ["rt2n4-20261126T120746Z", ""]] as const) {
    const d = join(work, n); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "release-commit.txt"), "abc123\n"); writeFileSync(join(d, "a.txt"), "hello"); if (snap) writeFileSync(join(d, "snapshot-id.txt"), snap + "\n");
    spawnSync("bash", ["-c", `cd ${d} && sha256sum a.txt release-commit.txt > SHA256SUMS`]);
  }
  return { dir, work, dest };
}
const run = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) => spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, DEST: s.dest, WORKS: s.work, ...env } });

describe("SAVE_ROLLBACK_REFS.sh", () => {
  it("saves each capture once, verifies checksums, writes the index with the right commands, and does not overwrite on a second run", () => {
    const s = setup();
    try {
      let r = run(s); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("DONE: 2 new, 0 already saved");
      const idx = readFileSync(join(s.dest, "INDEX.md"), "utf8");
      expect(idx).toContain("rt2n3-20261125T195943Z"); expect(idx).toContain("ROLLBACK-TEST-0120"); expect(idx).toContain("snap-3"); expect(idx).toContain("ROLLBACK-TEST-EMAIL"); expect(idx).toContain("abc123");
      writeFileSync(join(s.dest, "rt2n3-20261125T195943Z", "a.txt"), "changed");   // the saved copy must not be overwritten by a second run
      r = run(s); expect(r.stdout).toContain("DONE: 0 new, 2 already saved"); expect(readFileSync(join(s.dest, "rt2n3-20261125T195943Z", "a.txt"), "utf8")).toBe("changed");
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
  it("refuses to go over the size limit and removes a copy that fails its checksums; the original is never touched", () => {
    const s = setup();
    try {
      let r = run(s, { LIMIT_MB: "0" }); expect(r.status).toBe(2); expect(r.stderr).toContain("over 0 MB");
      writeFileSync(join(s.work, "rt2n3-20261125T195943Z", "SHA256SUMS"), "0".repeat(64) + "  a.txt\n");
      r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("does not match its checksums"); expect(existsSync(join(s.dest, "rt2n3-20261125T195943Z"))).toBe(false);
      expect(readFileSync(join(s.work, "rt2n3-20261125T195943Z", "a.txt"), "utf8")).toBe("hello");
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
});
