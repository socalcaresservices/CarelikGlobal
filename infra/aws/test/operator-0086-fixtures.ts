// Shared fixtures for the TEST 0086 operator package tests (release 7870a04, decision D1 option b). Builds a SYNTHETIC git repository that carries the REAL migrations and rollbacks (so the pinned
// hashes are the real ones), then runs the REAL build-operator-tarball.sh on it. No AWS, no network, synthetic data only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PKG_REL = "docs/releases/2026-10-26-redesign-operator";
export const SCRIPTS_SRC = join(REPO_ROOT, PKG_REL, "scripts");
export const FIXTURES = fileURLToPath(new URL("./fixtures/operator-0086/", import.meta.url));
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", input: opts.input, env: { ...process.env, ...(opts.env ?? {}) } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
}

export interface SynthRepo { dir: string; repo: string; sha: string; short: string; lock: string }
/** A throwaway repository: committed code (real migrations and rollbacks) plus an UNCOMMITTED package folder copied from the real one. */
export function makeRepo(): SynthRepo {
  const dir = mkdtempSync(join(tmpdir(), "op0086-pkg-"));
  const repo = join(dir, "repo");
  const w = (p: string, c: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); };
  mkdirSync(repo, { recursive: true });
  for (const p of ["infra/aws/db/migrations", "infra/aws/db/rollback", "infra/aws/db/pending"]) cpSync(join(REPO_ROOT, p), join(repo, p), { recursive: true });
  w("infra/aws/bin/ogevia.ts", "// synthetic\n"); w("infra/aws/package.json", "{}\n"); w("infra/aws/lib/x.ts", "// synthetic\n");
  w("infra/aws/cdk.out/Ogevia-prd-Stale.template.json", "{}\n"); // tracked in the real repo; must NOT travel
  w("apps/sv-api/package.json", "{}\n"); w("apps/sv-api/src/a.ts", "// a\n"); w("apps/web/package.json", "{}\n"); w("apps/web/src/env.ts", "// env\n");
  w("packages/shared/package.json", "{}\n"); w("package.json", "{}\n"); w("pnpm-lock.yaml", "lock: 1\n"); w("pnpm-workspace.yaml", "packages: []\n"); w("turbo.json", "{}\n"); w("tsconfig.base.json", "{}\n");
  w("docs/TESTING_AND_RELEASE_PROCESS.md", "# process\n"); w("docs/release-process/A.md", "# a\n");
  w("docs/releases/other/shot.png", "PNG"); w("_backup/predeploy/secret.txt", "backup\n"); w(".gitignore", "node_modules\n");
  const g = (...a: string[]) => sh("git", ["-C", repo, ...a]);
  g("init", "-q"); g("config", "user.email", "t@example.test"); g("config", "user.name", "t"); g("add", "-A"); g("commit", "-q", "-m", "synthetic code commit");
  const sha = g("rev-parse", "HEAD").stdout.trim();
  const short = sha.slice(0, 7);
  addPackageFolder(repo, short);
  return { dir, repo, sha, short, lock: sha256("lock: 1\n") };
}
/** the package folder: the REAL scripts, uncommitted */
export function addPackageFolder(repo: string, short: string) {
  const dest = join(repo, PKG_REL);
  mkdirSync(dest, { recursive: true });
  cpSync(SCRIPTS_SRC, join(dest, "scripts"), { recursive: true });
  writeFileSync(join(dest, `OPERATOR_PROCEDURE_${short}.md`), "# synthetic procedure\n");
  writeFileSync(join(dest, "README.md"), "# synthetic readme\n");
}
export function buildScript(r: SynthRepo) { return join(r.repo, PKG_REL, "scripts", "build-operator-tarball.sh"); }
export function build(r: SynthRepo, outDir: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
  return sh("bash", [buildScript(r), "--out-dir", outDir, ...args], { cwd: r.repo, env: { OGEVIA_BUILD_TIME: "2026-10-26T12:00:00Z", ...env } });
}
export interface Extracted { root: string; scripts: string; bin: string; tar: string; tarSha: string }
/** build, then extract into a fresh directory with fake node/pnpm/npx and empty node_modules (as after `pnpm install`) */
export function buildAndExtract(r: SynthRepo, versions: { node?: string; pnpm?: string; cdk?: string } = {}): Extracted {
  const out = mkdtempSync(join(tmpdir(), "op0086-out-"));
  const b = build(r, out);
  if (b.code !== 0) throw new Error("build failed: " + b.out);
  const tar = join(out, `ogevia-operator-${r.short}.tar.gz`);
  const ex = mkdtempSync(join(tmpdir(), "op0086-ex-"));
  const x = sh("tar", ["-xzf", tar, "-C", ex]);
  if (x.code !== 0) throw new Error("extract failed: " + x.out);
  const root = join(ex, `ogevia-test-0086-${r.short}`);
  mkdirSync(join(root, "node_modules"), { recursive: true }); mkdirSync(join(root, "infra/aws/node_modules"), { recursive: true });
  const bin = join(ex, "bin"); mkdirSync(bin);
  const fake = (n: string, body: string) => { writeFileSync(join(bin, n), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, n), 0o755); };
  fake("node", `echo ${versions.node ?? "v22.22.0"}`); fake("pnpm", `echo ${versions.pnpm ?? "9.15.4"}`); fake("npx", `echo "${versions.cdk ?? "2.1143.0 (build abc)"}"`);
  return { root, scripts: join(root, PKG_REL, "scripts"), bin, tar, tarSha: readFileSync(tar + ".sha256", "utf8").split(" ")[0]! };
}
export const exists = existsSync;
