// The operator procedure for the TEST 0086 release cannot drift from the code: every pin in it equals the real value, every script it names exists, the staff routes are the routes the code
// registers, deployment goes only through the guard, and no command in it names production or git.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PKG_REL, REPO_ROOT } from "./operator-0086-fixtures.js";

const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(join(REPO_ROOT, p))).digest("hex");
const doc = read(`${PKG_REL}/OPERATOR_PROCEDURE_730b601.md`);
const readme = read(`${PKG_REL}/README.md`);
const SCRIPTS = readdirSync(join(REPO_ROOT, PKG_REL, "scripts"));
const blocks = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!);
const commands = blocks.join("\n");
const migSet = () => {
  const files = readdirSync(join(REPO_ROOT, "infra/aws/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  return createHash("sha256").update(files.map((f) => `${sha(`infra/aws/db/migrations/${f}`)}  ${f}\n`).join("")).digest("hex");
};

describe("the pins in the procedure are the real values", () => {
  it("migration set, 0086 and 0087 up and down, lockfile", () => {
    expect(readdirSync(join(REPO_ROOT, "infra/aws/db/migrations")).filter((f) => f.endsWith(".sql"))).toHaveLength(85);
    expect(existsSync(join(REPO_ROOT, "infra/aws/db/migrations/0086_staff_management.sql"))).toBe(false);
    expect(doc).toContain(migSet());
    expect(doc).toContain(sha("infra/aws/db/pending/migrations/0086_staff_management.sql"));
    expect(doc).toContain(sha("infra/aws/db/pending/rollback/0086_staff_management.down.sql"));
    expect(doc).toContain(sha("infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql"));
    expect(doc).toContain(sha("infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql"));
    expect(existsSync(join(REPO_ROOT, "infra/aws/db/migrations/0087_staff_invitation_acceptance.sql"))).toBe(false);
    expect(doc).toContain(sha("pnpm-lock.yaml"));
    expect(read(`${PKG_REL}/scripts/pkg-lib.sh`)).toContain(migSet());
  });
  it("code commit, Handler keys, route count and fingerprint prefixes agree with assembly_check.py", () => {
    const asm = read(`${PKG_REL}/scripts/assembly_check.py`);
    expect(doc).toContain("730b60166409cef217be15e7d20618538a1e131f");
    expect(asm).toContain("730b60166409cef217be15e7d20618538a1e131f");
    for (const key of asm.match(/[0-9a-f]{64}\.zip/g)!) expect(doc).toContain(key);
    expect(asm).toMatch(/ROUTES = 242/); expect(doc).toContain("242");
    for (const m of asm.matchAll(/"Ogevia-prod-[A-Za-z]+": "([0-9a-f]{64})"/g)) expect(doc).toContain(m[1]!.slice(0, 8));
    expect(read(`${PKG_REL}/scripts/record-deployed.sh`)).toContain("2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip");
  });
  it("the typed phrases in the procedure are the ones the scripts ask for", () => {
    expect(doc).toContain("OPEN-5432-WINDOW-APPLY-0087-TEST"); expect(read(`${PKG_REL}/scripts/apply-0087-test.sh`)).toContain("OPEN-5432-WINDOW-APPLY-0087-TEST");
    expect(doc).toContain("OPEN-5432-WINDOW-ROLLBACK-0087-TEST"); expect(read(`${PKG_REL}/scripts/apply-0087-test.sh`)).toContain("OPEN-5432-WINDOW-ROLLBACK-0087-TEST");
    expect(doc).toContain("DEPLOY-Ogevia-prod-ServiceVerificationApi");
    expect(doc).toContain("OPEN-5432-WINDOW` only");
  });
});

describe("the staff routes", () => {
  const keys: string[] = JSON.parse(read(`${PKG_REL}/scripts/new-route-keys.json`));
  it("the JSON lists the ONE route this upgrade adds; it is in the gate, the assembly check and the API behind the staffManagement switch; the assembly check pins all 14 staff routes", () => {
    expect(keys).toEqual(["POST /v1/me/staff-invitations/{organizationId}/accept"]);
    const gate = read(`${PKG_REL}/scripts/diff_gate.py`), asm = read(`${PKG_REL}/scripts/assembly_check.py`);
    for (const k of keys) { expect(gate).toContain(`"${k}"`); expect(asm).toContain(`"${k}"`); expect(k).toMatch(/^(GET|POST) \/v1\//); }
    const stack = read("infra/aws/lib/service-verification-api-stack.ts");
    const all = [...stack.matchAll(/apigw\.HttpMethod\.(GET|POST), path: "([^"]+)", feature: "staffManagement"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(all).toHaveLength(14);
    for (const k of all) expect(asm, k).toContain(`"${k}"`);
    for (const k of keys) expect(all).toContain(k);
  });
});

describe("structure and safety of the procedure", () => {
  it("has Steps 0 to 16 in order, each with a command block, and the recovery R1 to R7 and the stop conditions", () => {
    const steps = [...doc.matchAll(/^### Step (\d+) - /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual(Array.from({ length: 17 }, (_, i) => i));
    for (let i = 0; i < 17; i++) {
      const sec = doc.split(new RegExp(`^### Step ${i} - `, "m"))[1]!.split(/^### Step \d+ - |^## /m)[0]!;
      if (i !== 13) expect(sec, `Step ${i}`).toMatch(/```\n[\s\S]*?```/);
      expect(sec, `Step ${i}`).toMatch(/Expected|Stop/);
    }
    for (let i = 1; i <= 7; i++) expect(doc).toMatch(new RegExp(`^### R${i} `, "m"));
    expect(doc).toMatch(/^## 9\. Stop conditions/m); expect(doc).toMatch(/^## 10\. What this procedure does not do/m);
  });
  it("deploys only through the guard: no raw cdk deploy, no all-stacks flag, no production stack, no git, no migration runner against TEST", () => {
    expect(commands).not.toMatch(/cdk deploy/);
    expect(commands).not.toMatch(/--all\b|--force|--hotswap|--no-rollback/);
    expect(commands).not.toMatch(/Ogevia-prd|ogevia_prd|zk527zk4ua|FHJoX71ca/);
    expect(commands).not.toMatch(/(^|[\s(;&|])git\s/m);
    expect(commands).not.toMatch(/db\/scripts\/migrate\.ts|npx tsx/);
    expect(commands).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
    expect(commands).toContain('deploy-guard.sh" deploy Ogevia-prod-ServiceVerificationApi');
    expect([...commands.matchAll(/deploy-guard\.sh" deploy (\S+)/g)].map((m) => m[1])).toEqual(["Ogevia-prod-ServiceVerificationApi"]);
  });
  it("every script a command names exists in the package, and the order is the owner's: ledger, snapshot, gates, 0087, API, web", () => {
    for (const m of commands.matchAll(/\$S\/([A-Za-z0-9_.-]+)/g)) expect(SCRIPTS, m[1]).toContain(m[1]);
    for (const f of SCRIPTS) if (f !== "pkg-lib.sh" && f !== "build-operator-tarball.sh") expect(doc, f).toContain(f.replace(/\.(sh|py|sql|json)$/, ""));
    const at = (needle: string) => commands.indexOf(needle); // the order of the COMMANDS, not of the prose
    const order = ["ledger-recheck.sh\" test --host-ip", "snapshot-verify.sh\" create", "deploy-guard.sh\" check", "apply-0087-test.sh\" apply", "deploy-guard.sh\" deploy", "deploy-test-slice.sh web", "route-smoke.sh", "record-deployed.sh"].map(at);
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("states D1 option (b), the TEST-only boundary, the ledger staying 85 / 0085, and that nothing was run against AWS", () => {
    expect(doc).toContain("NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS");
    expect(doc).toContain("D1 option (b)"); expect(doc).toMatch(/85 \/ 0085/); expect(doc).toContain("without a ledger row");
    expect(doc).toContain("TEST only"); expect(doc).toContain("never named as a target");
  });
  it("the gate no longer allows any CORS catch-up: the demo origin allowance is gone and the procedure says so", () => {
    const gate = read(`${PKG_REL}/scripts/diff_gate.py`);
    expect(gate).not.toContain("DEMO_ORIGIN");
    expect(doc).toContain("old one-origin catch-up allowance was removed");
    expect(doc).toContain("any CORS, hostname or callback difference stops");
  });
  it("the README lists every script in the package", () => { for (const f of SCRIPTS) expect(readme, f).toContain(f.replace(/\.(sh|py|sql|json)$/, "")); });
  it("contains no secret, no email address and no database password pattern", () => {
    expect(doc + readme).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN|password\s*[:=]\s*\S|@(gmail|outlook|yahoo)\./i);
  });
});
