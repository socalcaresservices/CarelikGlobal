// build-operator-tarball.sh and tarball-pin-check.sh (docs/releases/2026-10-19-test-rehearsal/scripts), run for real on a SYNTHETIC repository that carries the real
// migrations and rollbacks. No AWS, no network. The pin check has NO git: it must prove identity from BUILD_INFO.json and the manifest, and every failure must exit non-zero.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PKG_REL, REPO_ROOT, build, buildAndExtract, makeRepo, sh, sha256, type SynthRepo } from "./rehearsal-fixtures.js";
import { vi } from "vitest";

vi.setConfig({ testTimeout: 120000 });
const REAL_MIGRATION_SET = "272afa6078efc61df3a87a198ec13b20e8b3eed8b301b8c9afd01a389ae17145";
const REAL_ROLLBACK_SET = "52b9b8735e0f4e2c025a24bbc98a447cdc5ac3154ae4e042b0382ebda7cdb799";
const APPLIED_0077 = "90785eaa779a0be2fc46aa7c251294c102b83d0d240b693ea9fb0d5fffc9a335";
let r: SynthRepo;
beforeAll(() => { r = makeRepo(); });

const pinEnv = (extra: Record<string, string> = {}) => ({ OGEVIA_EXPECT_COMMIT: r.sha, OGEVIA_EXPECT_MIGRATIONS_SHA: REAL_MIGRATION_SET, OGEVIA_EXPECT_LOCKFILE_SHA: r.lock, ...extra });
const pin = (e: ReturnType<typeof buildAndExtract>, env: Record<string, string> = {}) =>
  sh("bash", [join(e.scripts, "tarball-pin-check.sh")], { env: { PATH: `${e.bin}:${process.env.PATH}`, ...pinEnv(env) } });

describe("build-operator-tarball.sh", () => {
  it("builds the tarball with BUILD_INFO.json, a manifest of every file, and a .sha256, and verifies itself", () => {
    const out = mkdtempSync(join(tmpdir(), "tb-out-"));
    const b = build(r, out, [], { OGEVIA_APPROVAL_REF: "REF-TEST-0001" });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain("BUILT AND SELF-VERIFIED");
    expect(b.out).toContain(`code commit        : ${r.sha}`);
    expect(b.out).toContain(`migration set 0001-0084 sha256 : ${REAL_MIGRATION_SET}`);
    expect(b.out).toContain(`rollback set 0078-0084 sha256  : ${REAL_ROLLBACK_SET}`);
    const tar = join(out, `ogevia-operator-${r.short}.tar.gz`);
    expect(readFileSync(tar + ".sha256", "utf8")).toBe(`${sha256(readFileSync(tar))}  ogevia-operator-${r.short}.tar.gz\n`);
    expect(b.out).toContain(`tarball sha256     : ${sha256(readFileSync(tar))}`);
    const info = JSON.parse(readFileSync(join(out, "BUILD_INFO.json"), "utf8"));
    expect(info).toMatchObject({ code_commit: r.sha, package_built_utc: "2026-10-19T12:00:00Z", approval_ref: "REF-TEST-0001", package_folder: PKG_REL });
    expect(info.code_tree).toMatch(/^[0-9a-f]{40}$/);
    // the manifest lists every file (hash + path) except itself, and the tarball list agrees
    const manifest = readFileSync(join(out, "PACKAGE_MANIFEST.sha256"), "utf8").trim().split("\n");
    const listed = sh("tar", ["-tzf", tar]).stdout.split("\n").filter((l) => l && !l.endsWith("/")).map((l) => l.replace(/^[^/]+\//, ""));
    expect(listed.sort()).toEqual([...manifest.map((l) => l.slice(66)), "PACKAGE_MANIFEST.sha256"].sort());
    expect(manifest.every((l) => /^[0-9a-f]{64}  \S+$/.test(l))).toBe(true);
    // the package folder travels; the stale tracked cdk.out, _backup, other release folders and screenshots do not
    const names = listed.join("\n");
    expect(names).toContain(`${PKG_REL}/scripts/tarball-pin-check.sh`);
    expect(names).toContain(`${PKG_REL}/OPERATOR_PROCEDURE_${r.short}.md`);
    expect(names).toContain("infra/aws/db/migrations/0084_action_needed_over_limit.sql");
    expect(names).toContain("docs/TESTING_AND_RELEASE_PROCESS.md");
    for (const bad of ["cdk.out", "_backup", "docs/releases/other", "shot.png", "node_modules", ".git/"]) expect(names).not.toContain(bad);
  });

  it("is byte-for-byte reproducible for the same inputs and build time", () => {
    const a = mkdtempSync(join(tmpdir(), "tb-a-")), c = mkdtempSync(join(tmpdir(), "tb-c-"));
    expect(build(r, a).code).toBe(0); expect(build(r, c).code).toBe(0);
    const f = `ogevia-operator-${r.short}.tar.gz`;
    expect(sha256(readFileSync(join(a, f)))).toBe(sha256(readFileSync(join(c, f))));
    // a different build time changes BUILD_INFO and so the tarball hash
    const d = mkdtempSync(join(tmpdir(), "tb-d-"));
    expect(build(r, d, [], { OGEVIA_BUILD_TIME: "2026-10-19T13:00:00Z" }).code).toBe(0);
    expect(sha256(readFileSync(join(d, f)))).not.toBe(sha256(readFileSync(join(a, f))));
  });

  it("takes the code from the COMMIT: an uncommitted edit to code never travels, an uncommitted package file does", () => {
    const x = makeRepo();
    writeFileSync(join(x.repo, "infra/aws/lib/x.ts"), "// UNCOMMITTED EDIT\n");
    writeFileSync(join(x.repo, PKG_REL, "README.md"), "# edited package readme\n");
    const e = buildAndExtract(x);
    expect(readFileSync(join(e.root, "infra/aws/lib/x.ts"), "utf8")).toBe("// synthetic\n");
    expect(readFileSync(join(e.root, PKG_REL, "README.md"), "utf8")).toBe("# edited package readme\n");
  });

  it.each([
    ["an output directory inside the repository", (x: SynthRepo) => build(x, join(x.repo, "out")), "OUTSIDE the repository"],
    ["a commit that does not exist", (x: SynthRepo) => build(x, mkdtempSync(join(tmpdir(), "tb-")), ["--code-commit", "deadbeef"]), "cannot resolve"],
    ["an invalid approval reference", (x: SynthRepo) => build(x, mkdtempSync(join(tmpdir(), "tb-")), [], { OGEVIA_APPROVAL_REF: "no" }), "OGEVIA_APPROVAL_REF"],
    ["an invalid build time", (x: SynthRepo) => build(x, mkdtempSync(join(tmpdir(), "tb-")), [], { OGEVIA_BUILD_TIME: "tomorrow-ish" }), "OGEVIA_BUILD_TIME"],
  ])("refuses %s", (_n, run, text) => {
    const x = makeRepo();
    const b = run(x);
    expect(b.code, b.out).toBe(1);
    expect(b.out).toContain(text);
  });
  it("refuses without --out-dir (usage, exit 2) and when the procedure file for the commit is missing", () => {
    const x = makeRepo();
    expect(sh("bash", [join(x.repo, PKG_REL, "scripts/build-operator-tarball.sh")], { cwd: x.repo }).code).toBe(2);
    rmSync(join(x.repo, PKG_REL, `OPERATOR_PROCEDURE_${x.short}.md`));
    const b = build(x, mkdtempSync(join(tmpdir(), "tb-")));
    expect(b.code, b.out).toBe(1);
    expect(b.out).toContain(`OPERATOR_PROCEDURE_${x.short}.md is missing`);
  });
  it("refuses a symbolic link, an image or a file name with whitespace anywhere in the package", () => {
    for (const [label, mutate, text] of [
      ["symlink in the package folder", (x: SynthRepo) => symlinkSync("/etc/passwd", join(x.repo, PKG_REL, "scripts/link")), "symbolic link"],
      ["screenshot in the package folder", (x: SynthRepo) => writeFileSync(join(x.repo, PKG_REL, "shot.png"), "PNG"), "screenshots are excluded"],
      ["whitespace in a name", (x: SynthRepo) => writeFileSync(join(x.repo, PKG_REL, "a b.md"), "x"), "whitespace"],
    ] as Array<[string, (x: SynthRepo) => void, string]>) {
      const x = makeRepo(); mutate(x);
      const b = build(x, mkdtempSync(join(tmpdir(), "tb-")));
      expect(b.code, `${label}: ${b.out}`).toBe(1);
      expect(b.out).toContain(text);
    }
  });
});

describe("tarball-pin-check.sh (no git): PINS HOLD only for the approved package", () => {
  it("holds for the approved commit, manifest, migration set, 0001-0077 set, lockfile and toolchain", () => {
    const e = buildAndExtract(r);
    const p = pin(e);
    expect(p.code, p.out).toBe(0);
    for (const line of [`PASS BUILD_INFO code commit ${r.sha}`, "PASS PACKAGE_MANIFEST verifies", "PASS no file outside the manifest", `PASS migration set (0001-0084) sha256 ${REAL_MIGRATION_SET.slice(0, 16)}`, `PASS migrations 0001-0077 equal the set applied to TEST on 2026-10-18 (${APPLIED_0077.slice(0, 16)}`, "PASS pnpm-lock.yaml", "PASS node v22.22.0", "PASS pnpm 9.15.4", "PASS dependencies installed", "PASS cdk 2.1143.0", "PINS HOLD"]) expect(p.out).toContain(line);
    expect(p.out).toContain("NOTE BUILD_INFO approval_ref is the placeholder");
  });
  it.each([
    ["the wrong code commit", { OGEVIA_EXPECT_COMMIT: "1".repeat(40) }, "not the approved"],
    ["the wrong migration-set pin", { OGEVIA_EXPECT_MIGRATIONS_SHA: "2".repeat(64) }, "db/migrations hashes to"],
    ["the wrong lockfile pin", { OGEVIA_EXPECT_LOCKFILE_SHA: "3".repeat(64) }, "pnpm-lock.yaml hashes to"],
  ])("stops (exit 1) on %s", (_n, env, text) => {
    const p = pin(buildAndExtract(r), env);
    expect(p.code, p.out).toBe(1);
    expect(p.out).toContain(text);
    expect(p.out).not.toContain("PINS HOLD");
  });
  it("usage: missing pins exit 2", () => {
    expect(pin(buildAndExtract(r), { OGEVIA_EXPECT_COMMIT: "" }).code).toBe(2);
  });
  it.each([["node 20", { node: "v20.11.0" }, "Node 22.x"], ["pnpm 10", { pnpm: "10.0.0" }, "not 9.15.4"], ["another CDK CLI", { cdk: "2.200.0 (build x)" }, "not 2.1143.0"]])("stops on %s", (_n, v, text) => {
    const p = pin(buildAndExtract(r, v as never));
    expect(p.code, p.out).toBe(1);
    expect(p.out).toContain(text);
  });
  it("stops when a packaged file was changed after the build (the manifest catches it), when one is missing, and when a stray file is added", () => {
    let e = buildAndExtract(r);
    writeFileSync(join(e.root, "apps/web/src/env.ts"), "// tampered\n");
    let p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("package manifest:"); expect(p.out).not.toContain("PINS HOLD");
    e = buildAndExtract(r); rmSync(join(e.root, "infra/aws/lib/x.ts"));
    p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("package manifest:");
    e = buildAndExtract(r); writeFileSync(join(e.root, "infra/aws/lib/stray.ts"), "x");
    p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("files not in the manifest: infra/aws/lib/stray.ts");
    // installed dependencies and build output are not strays
    e = buildAndExtract(r); mkdirSync(join(e.root, "apps/web/dist-aws"), { recursive: true }); writeFileSync(join(e.root, "apps/web/dist-aws/index.html"), "x"); writeFileSync(join(e.root, "node_modules/a.js"), "x");
    expect(pin(e).code).toBe(0);
  });
  it("stops when an APPLIED migration (0001-0077) was edited, even if the pinned set value is edited to match", () => {
    const x = makeRepo();
    // rewrite an existing applied migration in a commit, then build from it
    const first = readdirSync(join(x.repo, "infra/aws/db/migrations")).sort()[10]!;
    writeFileSync(join(x.repo, "infra/aws/db/migrations", first), "-- edited applied migration\n");
    sh("git", ["-C", x.repo, "add", "-A"]); sh("git", ["-C", x.repo, "commit", "-q", "-m", "edit applied"]);
    const sha = sh("git", ["-C", x.repo, "rev-parse", "HEAD"]).stdout.trim();
    const out = mkdtempSync(join(tmpdir(), "tb-")); const short = sha.slice(0, 7);
    writeFileSync(join(x.repo, PKG_REL, `OPERATOR_PROCEDURE_${short}.md`), "# p\n");
    expect(build(x, out).code).toBe(0);
    const ex = mkdtempSync(join(tmpdir(), "tb-ex-")); sh("tar", ["-xzf", join(out, `ogevia-operator-${short}.tar.gz`), "-C", ex]);
    const root = join(ex, `ogevia-rehearsal-${short}`); mkdirSync(join(root, "node_modules")); mkdirSync(join(root, "infra/aws/node_modules"));
    const bin = join(ex, "bin"); mkdirSync(bin);
    for (const [n, body] of [["node", "echo v22.22.0"], ["pnpm", "echo 9.15.4"], ["npx", "echo 2.1143.0"]]) { writeFileSync(join(bin, n!), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, n!), 0o755); }
    const migSet = sh("bash", ["-c", `cd ${root}/infra/aws/db/migrations && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1`]).stdout.trim();
    const p = sh("bash", [join(root, PKG_REL, "scripts/tarball-pin-check.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, OGEVIA_EXPECT_COMMIT: sha, OGEVIA_EXPECT_MIGRATIONS_SHA: migSet, OGEVIA_EXPECT_LOCKFILE_SHA: x.lock } });
    expect(p.code, p.out).toBe(1);
    expect(p.out).toContain("an applied migration was edited");
  });
  it("fails closed: a sha256sum that fails silently, an unreadable manifest and a missing BUILD_INFO are failures, never a pass (the old git-status weakness)", () => {
    const real = sh("bash", ["-c", "command -v sha256sum"]).stdout.trim();
    // 1. sha256sum -c exits non-zero and prints nothing
    let e = buildAndExtract(r);
    writeFileSync(join(e.bin, "sha256sum"), `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = -c ]; then exit 1; fi; done\nexec ${real} "$@"\n`); chmodSync(join(e.bin, "sha256sum"), 0o755);
    let p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("sha256sum -c exited 1"); expect(p.out).not.toContain("PINS HOLD");
    // 2. the disk-full style failure: the tool says so on stderr and exits 1
    e = buildAndExtract(r);
    writeFileSync(join(e.bin, "sha256sum"), `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = -c ]; then echo "sha256sum: write error: No space left on device" >&2; exit 1; fi; done\nexec ${real} "$@"\n`); chmodSync(join(e.bin, "sha256sum"), 0o755);
    p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("No space left on device");
    // 3. an empty manifest, 4. a missing BUILD_INFO
    e = buildAndExtract(r); writeFileSync(join(e.root, "PACKAGE_MANIFEST.sha256"), "");
    p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("missing or empty");
    e = buildAndExtract(r); rmSync(join(e.root, "BUILD_INFO.json"));
    p = pin(e); expect(p.code, p.out).toBe(1); expect(p.out).toContain("unreadable");
    // control: untouched package still holds
    expect(pin(buildAndExtract(r)).code).toBe(0);
  });
  it("an approval reference in BUILD_INFO that differs from the one exported for the run is a failure; a matching one passes", () => {
    const x = makeRepo();
    const out = mkdtempSync(join(tmpdir(), "tb-")); expect(build(x, out, [], { OGEVIA_APPROVAL_REF: "REF-GOOD-0001" }).code).toBe(0);
    const ex = mkdtempSync(join(tmpdir(), "tb-ex-")); sh("tar", ["-xzf", join(out, `ogevia-operator-${x.short}.tar.gz`), "-C", ex]);
    const root = join(ex, `ogevia-rehearsal-${x.short}`); mkdirSync(join(root, "node_modules")); mkdirSync(join(root, "infra/aws/node_modules"));
    const bin = join(ex, "bin"); mkdirSync(bin);
    for (const [n, body] of [["node", "echo v22.22.0"], ["pnpm", "echo 9.15.4"], ["npx", "echo 2.1143.0"]]) { writeFileSync(join(bin, n!), `#!/usr/bin/env bash\nexec_=1\n${body}\n`); chmodSync(join(bin, n!), 0o755); }
    const run = (ref: string) => sh("bash", [join(root, PKG_REL, "scripts/tarball-pin-check.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, OGEVIA_EXPECT_COMMIT: x.sha, OGEVIA_EXPECT_MIGRATIONS_SHA: REAL_MIGRATION_SET, OGEVIA_EXPECT_LOCKFILE_SHA: x.lock, OGEVIA_DEPLOY_APPROVAL: ref } });
    expect(run("REF-GOOD-0001").code).toBe(0);
    const bad = run("REF-OTHER-9999"); expect(bad.code, bad.out).toBe(1); expect(bad.out).toContain("differs from OGEVIA_DEPLOY_APPROVAL");
  });
  it("the tarball's own sha256 line verifies with sha256sum -c and fails after any change to the file", () => {
    const e = buildAndExtract(r);
    const dir = join(e.tar, "..");
    expect(sh("sha256sum", ["-c", `${e.tar}.sha256`], { cwd: dir }).code).toBe(0);
    writeFileSync(e.tar, Buffer.concat([readFileSync(e.tar), Buffer.from("x")]));
    expect(sh("sha256sum", ["-c", `${e.tar}.sha256`], { cwd: dir }).code).not.toBe(0);
  });
  it("is read-only: no git, no AWS, no write command in the pin check or the library", () => {
    for (const f of ["tarball-pin-check.sh", "pkg-lib.sh"]) {
      const code = readFileSync(join(REPO_ROOT, PKG_REL, "scripts", f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect(code, f).not.toMatch(/(^|[\s(;&|])(rm|mv|cp|git|aws|curl|tar|pnpm\s+install)\s/m);
    }
    expect(existsSync(join(REPO_ROOT, PKG_REL, "scripts/tarball-pin-check.sh"))).toBe(true);
  });
});
