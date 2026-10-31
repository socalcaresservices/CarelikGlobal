// The operator procedure for the PRODUCTION release cannot drift from the code: every pin in it equals the real value, every script it names exists, the 14 routes are the routes the code
// registers, deployment goes only through the guard, and no command in it names TEST, git or a raw deploy.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PKG_REL, REPO_ROOT } from "./operator-prd-fixtures.js";

const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(join(REPO_ROOT, p))).digest("hex");
const CODE = "730b60166409cef217be15e7d20618538a1e131f";
const doc = read(`${PKG_REL}/OPERATOR_PROCEDURE_PRD_730b601.md`);
const readme = read(`${PKG_REL}/README.md`);
const SCRIPTS = readdirSync(join(REPO_ROOT, PKG_REL, "scripts"));
const blocks = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!);
const commands = blocks.join("\n");
const migSet = () => {
  const files = readdirSync(join(REPO_ROOT, "infra/aws/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  return createHash("sha256").update(files.map((f) => `${sha(`infra/aws/db/migrations/${f}`)}  ${f}\n`).join("")).digest("hex");
};

describe("the pins in the procedure are the real values", () => {
  it("migration set, 0086 up and down, lockfile", () => {
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
  it("code commit, Handler keys and route count agree with assembly_check_prd.py, record-deployed-prd.sh and the builder", () => {
    const asm = read(`${PKG_REL}/scripts/assembly_check_prd.py`);
    expect(doc).toContain(CODE);
    for (const key of asm.match(/[0-9a-f]{64}\.zip/g)!) expect(doc).toContain(key);
    expect(asm).toMatch(/ROUTES = 242/); expect(doc).toContain("242");
    expect(read(`${PKG_REL}/scripts/record-deployed-prd.sh`)).toContain("2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip");
    expect(read(`${PKG_REL}/scripts/build-prd-tarball.sh`)).toContain("2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip");
    expect(read(`${PKG_REL}/scripts/web-prd.sh`)).toContain("e80b770210c54e423d28ecf48e00f1dda9506cec");   // the version string the captured production bundle carries
    expect(doc).toContain("e80b770210c54e423d28ecf48e00f1dda9506cec");
  });
  it("the production flag the Owner approved is in the code the package is built from", () => {
    expect(read("infra/aws/lib/config.ts")).toMatch(/features:\s*\{\s*staffManagement:\s*true\s*\}/);
  });
  it("the typed phrases in the procedure are the ones the scripts ask for", () => {
    const apply = read(`${PKG_REL}/scripts/apply-0086-prd.sh`), ledger = read(`${PKG_REL}/scripts/ledger-recheck-prd.sh`), web = read(`${PKG_REL}/scripts/web-prd.sh`);
    for (const [p, src] of [["OPEN-5432-WINDOW-APPLY-0086-PRD", apply], ["OPEN-5432-WINDOW-ROLLBACK-0086-PRD", apply], ["OPEN-5432-WINDOW-PRD", ledger], ["PUBLISH-WEB-Ogevia-prd", web], ["RESTORE-WEB-Ogevia-prd", web]] as const) { expect(doc, p).toContain(p); expect(src, p).toContain(p); }
    expect(doc).toContain("DEPLOY-Ogevia-prd-Auth"); expect(doc).toContain("DEPLOY-Ogevia-prd-ServiceVerificationApi");
    expect(read(`${PKG_REL}/scripts/deploy-guard-prd.sh`)).toContain('DEPLOY-$STACK');
  });
});

describe("the 14 routes and the gate's allow-list", () => {
  const keys: string[] = JSON.parse(read(`${PKG_REL}/scripts/new-route-keys.json`));
  it("are 14 distinct GET/POST keys, equal in the JSON, the gate and the assembly check, and each is registered by the API behind the staffManagement switch", () => {
    expect(new Set(keys).size).toBe(14);
    const gate = read(`${PKG_REL}/scripts/diff_gate_prd.py`), asm = read(`${PKG_REL}/scripts/assembly_check_prd.py`);
    for (const k of keys) { expect(gate).toContain(`"${k}"`); expect(asm).toContain(`"${k}"`); expect(k).toMatch(/^(GET|POST) \/v1\//); }
    const stack = read("infra/aws/lib/service-verification-api-stack.ts");
    for (const k of keys) { const [m, p] = k.split(" "); expect(stack, k).toContain(`apigw.HttpMethod.${m}, path: "${p}", feature: "staffManagement"`); }
    expect([...stack.matchAll(/feature: "staffManagement"/g)]).toHaveLength(14);
  });
  it("the origins and URLs the gate allows are exactly the ones the procedure and the code name", () => {
    const gate = read(`${PKG_REL}/scripts/diff_gate_prd.py`);
    for (const u of ["https://app.ogevia.com", "https://admin.ogevia.com", "https://app.ogevia.com/auth/callback", "https://admin.ogevia.com/auth/callback", "https://app.ogevia.com/", "https://admin.ogevia.com/"]) { expect(gate, u).toContain(u); expect(doc, u).toContain(u); }
    expect(gate).toContain("ExportsOutputRefTestSliceAppClient5EA2F71F"); expect(doc).toContain("ExportsOutputRefTestSliceAppClient5EA2F71F");
    const cfg = read("infra/aws/lib/config.ts");
    expect(cfg).toContain("app.ogevia.com"); expect(cfg).toContain("admin.ogevia.com");
  });
});

describe("structure and safety of the procedure", () => {
  it("has Steps 0 to 17 in order, each with a command block (Step 14 is manual) and an Expected or Stop line, the recovery R1 to R7 and the stop conditions", () => {
    const steps = [...doc.matchAll(/^### Step (\d+) - /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual(Array.from({ length: 18 }, (_, i) => i));
    for (let i = 0; i < 18; i++) {
      const sec = doc.split(new RegExp(`^### Step ${i} - `, "m"))[1]!.split(/^### Step \d+ - |^## /m)[0]!;
      if (i !== 14) expect(sec, `Step ${i}`).toMatch(/```\n[\s\S]*?```/);
      expect(sec, `Step ${i}`).toMatch(/Expected|Stop/);
    }
    for (const r of ["R1", "R2", "R2b", "R3", "R4", "R5", "R6", "R7"]) expect(doc).toMatch(new RegExp(`^### ${r} `, "m"));
    expect(doc).toMatch(/^## 9\. Stop conditions/m); expect(doc).toMatch(/^## 10\. What this procedure does not do/m);
  });
  it("deploys only through the guard, only the two stacks, in the order Auth then API; no raw cdk deploy, no all-stacks flag, no TEST stack, no git, no migration runner", () => {
    expect(commands).not.toMatch(/cdk deploy/);
    expect(commands).not.toMatch(/--all\b|--force|--hotswap|--no-rollback/);
    expect(commands).not.toMatch(/Ogevia-prod-(?!NetworkEgress)|ogevia_sv_test|s0epy5rgzb|849AYz5J7/);
    expect(commands).not.toMatch(/(^|[\s(;&|])git\s/m);
    expect(commands).not.toMatch(/db\/scripts\/migrate\.ts|npx tsx/);
    expect(commands).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
    expect([...commands.matchAll(/deploy-guard-prd\.sh" deploy (\S+)/g)].map((m) => m[1])).toEqual(["Ogevia-prd-Auth", "Ogevia-prd-ServiceVerificationApi"]);
  });
  it("every script a command names exists in the package, and the order is: pins, assembly, baseline, ledger, snapshot, gates, 0086, Auth, API, web, smoke, sweep, ledger, record", () => {
    for (const m of commands.matchAll(/\$S\/([A-Za-z0-9_.-]+)/g)) expect(SCRIPTS, m[1]).toContain(m[1]);
    for (const f of SCRIPTS) if (f !== "pkg-lib.sh" && f !== "build-prd-tarball.sh" && f !== "lib.sh") expect(doc, f).toContain(f.replace(/\.(sh|py|sql|json)$/, ""));
    const at = (needle: string, from = 0) => commands.indexOf(needle, from);
    const needles = ["tarball-pin-check.sh\"", "assembly_check_prd.py", "p0-baseline-capture.sh", "ledger-recheck-prd.sh\" prd --host-ip", "snapshot-verify-prd.sh\" create", "deploy-guard-prd.sh\" check", "apply-0086-prd.sh\" apply", "deploy-guard-prd.sh\" deploy Ogevia-prd-Auth", "deploy-guard-prd.sh\" deploy Ogevia-prd-ServiceVerificationApi", "web-prd.sh\" build", "web-prd.sh\" publish", "route-smoke-prd.sh", "compliance-sweep", "OGEVIA_EXPECT_0086=present", "record-deployed-prd.sh"];
    const order = needles.map((n) => at(n)); expect(order.every((x) => x > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("states production-only, D-P1/D-P2, the ledger staying 85 / 0085, no ledger row, that TEST exceptions do not carry over, and that nothing was run against AWS", () => {
    expect(doc).toContain("NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS");
    expect(doc).toContain("D-P1"); expect(doc).toContain("D-P2"); expect(doc).toMatch(/85 \/ 0085/); expect(doc).toContain("without a ledger row");
    expect(doc).toContain("no TEST exception carries over"); expect(doc).toContain("does not read, copy, classify or delete any production record");
  });
  it("the README lists every script in the package", () => { for (const f of SCRIPTS) expect(readme, f).toContain(f.replace(/\.(sh|py|sql|json)$/, "")); });
  it("contains no secret, no e-mail address and no database password pattern", () => {
    expect(doc + readme).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN|password\s*[:=]\s*\S|@(gmail|outlook|yahoo)\./i);
  });
});
