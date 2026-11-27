// TEST_RESET_CAREGIVER_PASSWORDS.sh with stand-in `aws`, `curl` and `psql`. Nothing touches AWS. SYNTHETIC ids only.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/TEST_RESET_CAREGIVER_PASSWORDS.sh", import.meta.url));
const SUBS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

function setup(over: { sitePool?: string; account?: string; noUser?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reset-")); const bin = join(dir, "bin"); mkdirSync(bin); const calls = join(dir, "calls"); writeFileSync(calls, "");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash
echo "aws $*" | sed -E 's/--password [^ ]+/--password <hidden>/' >> ${JSON.stringify(calls)}
case "$*" in
  *"sts get-caller-identity"*) echo ${over.account ?? "300094796789"};;
  *"list-users"*) sub="$(echo "$*" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"; if [[ "$sub" == "${over.noUser ?? "none"}" ]]; then echo None; else echo "user-$sub"; fi;;
  *"admin-set-user-password"*) ;;
  *"admin-user-global-sign-out"*) ;;
  *) echo "UNEXPECTED AWS CALL: $*" >&2; exit 9;;
esac
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho '{"VITE_COGNITO_USER_POOL_ID":"${over.sitePool ?? "us-west-2_849AYz5J7"}","VITE_COGNITO_CLIENT_ID":"x"}'\n`);
  writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash\necho "psql $*" | cut -c1-60 >> ${JSON.stringify(calls)}\n${SUBS.map((s, i) => `echo "${s}|TEST-CG-0${i + 1}"`).join("\n")}\n`);
  for (const f of ["aws", "curl", "psql"]) chmodSync(join(bin, f), 0o755);
  return { dir, bin, calls, file: join(dir, "passwords.csv") };
}
const run = (s: ReturnType<typeof setup>, args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, PGDATABASE: "ogevia_sv_test", OGEVIA_PASSWORD_FILE: s.file, HOME: s.dir, ...env } });
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: { calls: string }) => readFileSync(s.calls, "utf8");

describe("TEST_RESET_CAREGIVER_PASSWORDS.sh", () => {
  it("the dry run lists the caregivers and changes nothing", () => {
    const s = setup();
    try { const r = run(s); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("DRY RUN: nothing was changed. 3 caregiver account(s)"); expect(r.stdout).toContain("TEST-CG-02: will be reset"); expect(calls(s)).not.toMatch(/admin-set-user-password|sign-out/); } finally { done(s); }
  });
  it("apply needs the typed confirmation; without it nothing changes", () => {
    const s = setup();
    try { const r = run(s, ["apply"]); expect(r.status).not.toBe(0); expect(calls(s)).not.toMatch(/admin-set-user-password/); } finally { done(s); }
  });
  it("apply sets a new permanent password for each caregiver and signs them out; the passwords are in a private file and never printed", () => {
    const s = setup();
    try {
      const r = run(s, ["apply"], { OGEVIA_NO_CONFIRM: "1" });
      expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("DONE: 3 reset, 0 failed");
      const c = calls(s); expect((c.match(/admin-set-user-password/g) ?? []).length).toBe(3); expect((c.match(/admin-user-global-sign-out/g) ?? []).length).toBe(3);
      expect(c).toMatch(/--user-pool-id us-west-2_849AYz5J7 --username user-11111111/); expect(c).toContain("--permanent");
      const lines = readFileSync(s.file, "utf8").trim().split("\n"); expect(lines[0]).toBe("caregiver_code,password"); expect(lines).toHaveLength(4);
      for (const l of lines.slice(1)) { const [code, pw] = l.split(","); expect(code).toMatch(/^TEST-CG-0[123]$/); expect(pw!.length).toBeGreaterThanOrEqual(20); expect(pw).toMatch(/[a-z]/); expect(pw).toMatch(/[A-Z]/); expect(pw).toMatch(/[0-9]/); expect(r.stdout + r.stderr + c).not.toContain(pw!); }
      expect(new Set(lines.slice(1).map((l) => l.split(",")[1])).size).toBe(3);                              // each person has their own
      expect((statSync(s.file).mode & 0o777).toString(8)).toBe("600");
    } finally { done(s); }
  });
  it("refuses another AWS account, a site that uses a different pool, and a database that is not the TEST database; a person with no pool account is skipped", () => {
    let s = setup({ account: "111111111111" }); try { expect(run(s, ["apply"], { OGEVIA_NO_CONFIRM: "1" }).stderr).toContain("wrong AWS account"); expect(calls(s)).not.toMatch(/admin-set/); } finally { done(s); }
    s = setup({ sitePool: "us-west-2_OTHERPOOL" }); try { const r = run(s, ["apply"], { OGEVIA_NO_CONFIRM: "1" }); expect(r.status).toBe(2); expect(r.stderr).toContain("not 'us-west-2_849AYz5J7'"); expect(calls(s)).not.toMatch(/admin-set/); } finally { done(s); }
    s = setup(); try { const r = run(s, ["apply"], { OGEVIA_NO_CONFIRM: "1", PGDATABASE: "ogevia_prd" }); expect(r.status).toBe(2); expect(r.stderr).toContain("TEST_DB_SESSION.sh"); expect(calls(s)).not.toMatch(/admin-set/); } finally { done(s); }
    s = setup({ noUser: SUBS[1]! }); try { const r = run(s, ["apply"], { OGEVIA_NO_CONFIRM: "1" }); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("TEST-CG-02: no sign-in account in the pool (skipped)"); expect(r.stdout).toContain("DONE: 2 reset"); } finally { done(s); }
  });
  it("the SQL lists only active caregivers who hold no other role", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain("m.role = 'caregiver'"); expect(text).toContain("o.role <> 'caregiver'"); expect(text).toContain("u.status = 'active'"); expect(text).not.toMatch(/list-users[^\n]*--query 'Users\[\]/);
  });
});
