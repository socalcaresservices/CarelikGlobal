// slice/candidate-pin-check.sh in a throwaway git clone with fake node, pnpm and npx: every pin must hold, and a broken pin stops with nothing changed. Synthetic.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../slice/candidate-pin-check.sh", import.meta.url));
const source = readFileSync(SRC, "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture(versions: { node?: string; pnpm?: string; cdk?: string } = {}, opts: { badPin?: boolean; noPins?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pin-"));
  const repo = join(dir, "repo"), infra = join(repo, "infra", "aws");
  mkdirSync(join(infra, "slice"), { recursive: true }); mkdirSync(join(infra, "db", "migrations"), { recursive: true }); mkdirSync(join(infra, "node_modules"), { recursive: true }); mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(infra, "db", "migrations", "0001_a.sql"), "-- a\n"); writeFileSync(join(infra, "db", "migrations", "0002_b.sql"), "-- b\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lock: 1\n"); writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  copyFileSync(SRC, join(infra, "slice", "candidate-pin-check.sh"));
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t"); git("add", "-A"); git("commit", "-q", "-m", "x");
  // the content-pin manifest: the git object ids of the application paths as the candidate had them, committed as part of the operator commit
  if (!opts.noPins) {
    const lines = ["infra/aws/db", "pnpm-lock.yaml"].map((pth) => `${opts.badPin && pth === "infra/aws/db" ? "0".repeat(40) : git("rev-parse", `HEAD:${pth}`).stdout.trim()} ${pth}`).join("\n") + "\n";
    writeFileSync(join(infra, "slice", "candidate-pins.txt"), lines);
    git("add", "-A"); git("commit", "-q", "-m", "operator tooling");
  }
  const bin = join(dir, "bin"); mkdirSync(bin);
  const fake = (n: string, body: string) => { writeFileSync(join(bin, n), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, n), 0o755); };
  fake("node", `echo ${versions.node ?? "v22.22.0"}`); fake("pnpm", `echo ${versions.pnpm ?? "9.15.4"}`); fake("npx", `echo "${versions.cdk ?? "2.1143.0 (build abc)"}"`);
  const mig = sha(`${sha("-- a\n")}  0001_a.sql\n${sha("-- b\n")}  0002_b.sql\n`);
  return { dir, repo, bin, env: { OGEVIA_EXPECT_COMMIT: git("rev-parse", "HEAD").stdout.trim(), OGEVIA_EXPECT_MIGRATIONS_SHA: mig, OGEVIA_EXPECT_LOCKFILE_SHA: sha("lock: 1\n") }, script: join(infra, "slice", "candidate-pin-check.sh") };
}
const run = (f: ReturnType<typeof fixture>, env: Record<string, string> = {}) => {
  const r = spawnSync("bash", [f.script], { encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, ...f.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("candidate-pin-check.sh", () => {
  it("holds for the approved commit, migration set, lockfile and toolchain", () => {
    const r = run(fixture());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PINS HOLD");
  });
  it.each([
    ["another commit", { OGEVIA_EXPECT_COMMIT: "1".repeat(40) }, "not the approved"],
    ["another migration set", { OGEVIA_EXPECT_MIGRATIONS_SHA: "2".repeat(64) }, "db/migrations hashes to"],
    ["another lockfile", { OGEVIA_EXPECT_LOCKFILE_SHA: "3".repeat(64) }, "pnpm-lock.yaml hashes to"],
  ])("stops on %s", (_n, env, text) => {
    const r = run(fixture(), env);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text);
  });
  it.each([["node 20", { node: "v20.11.0" }, "Node 22.x"], ["pnpm 10", { pnpm: "10.0.0" }, "not 9.15.4"], ["another CDK CLI", { cdk: "2.200.0 (build x)" }, "not 2.1143.0"]])("stops on %s", (_n, v, text) => {
    const r = run(fixture(v as never));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text);
  });
  it("stops when a pinned application path is not what the candidate had, or the pin manifest is missing", () => {
    const bad = run(fixture({}, { badPin: true }));
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toContain("infra/aws/db is");
    const none = run(fixture({}, { noPins: true }));
    expect(none.code, none.out).toBe(1);
    expect(none.out).toContain("candidate-pins.txt is missing or empty");
    expect(run(fixture()).out).toContain("2 content pins equal the CI-tested candidate");
  });
  it("stops on a modified or stray file and on missing pins; it never writes anything", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "stray.txt"), "x");
    const dirty = run(f);
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("working tree has changes");
    expect(run(fixture(), { OGEVIA_EXPECT_COMMIT: "" }).code).toBe(2);
    // it changes nothing: no write, move, checkout, fetch or AWS call anywhere in the script
    expect(source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")).not.toMatch(/(^|[\s(;&|])(rm|mv|cp|git\s+(checkout|fetch|pull|reset|clean)|aws)\s/m);
  });
});
