// TEST_INVENTORY.sh with a stand-in `aws` (only read-only calls are answered) and check_inventory.py on good and damaged inventories. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/", import.meta.url));
const route = (key: string) => ({ Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: key } });
const template = (n: number) => ({ Resources: Object.fromEntries(Array.from({ length: n }, (_, i) => [`R${i}`, route(`GET /v1/r${i}`)])) });
const HOST_T = "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", HOST_P = "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com";

function makeAws(root: string, over: { account?: string; routes?: number; testDb?: string } = {}) {
  const calls = join(root, "calls"); writeFileSync(calls, "");
  const answers = {
    account: over.account ?? "300094796789",
    template: JSON.stringify({ TemplateBody: { Parameters: { ClientQrEncryptionKey: { NoEcho: true, Default: "super-secret" } }, ...template(over.routes ?? 259) } }),
    testDb: over.testDb ?? "ogevia_sv_test",
  };
  writeFileSync(join(root, "answers.json"), JSON.stringify(answers));
  const aws = `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args[:4] == ["--cli-connect-timeout", "5", "--cli-read-timeout", "60"]: args = args[4:]
line = " ".join(args)
open(${JSON.stringify(calls)}, "a").write(line + "\\n")
ans = json.load(open(${JSON.stringify(join(root, "answers.json"))}))
prd = "Ogevia-prd" in line or "handler-prod" in line
def out(x): print(x if isinstance(x, str) else json.dumps(x))
if "sts get-caller-identity" in line: out(ans["account"])
elif "describe-stacks" in line and "WebHosting" in line: out({"status": "UPDATE_COMPLETE", "outputs": []})
elif "describe-stacks" in line: out({"name": "stack", "status": "UPDATE_COMPLETE"})
elif "get-template" in line: out(json.loads(ans["template"])["TemplateBody"])
elif "list-stack-resources" in line:
    out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "handler-prod" if prd else "handler-test"}, {"ResourceType": "AWS::ApiGatewayV2::Api", "LogicalResourceId": "Api", "PhysicalResourceId": "api-prod" if prd else "api-test"}]})
elif "get-function-configuration" in line:
    out({"function": "f", "codeSha256": "x", "dbHost": ${JSON.stringify(HOST_P)} if prd else ${JSON.stringify(HOST_T)}, "dbName": "ogevia_prd" if prd else ans["testDb"], "envName": "prd" if prd else "prod"})
elif "get-routes" in line: out(["GET /v1/r%d" % i for i in range(260)])
elif "describe-db-instances" in line:
    out([{"instance": "ogevia-postgres", "host": "h1", "port": 5432, "public": False, "backupDays": 7, "engine": "16", "status": "available", "encrypted": True}, {"instance": "ogevia-prod-postgres", "host": "h2", "port": 5432, "public": False, "backupDays": 7, "engine": "16", "status": "available", "encrypted": True}])
else:
    sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`;
  writeFileSync(join(root, "aws"), aws); chmodSync(join(root, "aws"), 0o755);
  writeFileSync(join(root, "curl"), `#!/usr/bin/env bash\nout=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done; [[ -n "$out" ]] && echo '<html>ok</html>' > "$out"; printf 200\n`); chmodSync(join(root, "curl"), 0o755);
  return calls;
}
function run(over: Parameters<typeof makeAws>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "inv-"));
  const calls = makeAws(root, over);
  const out = join(root, "out");
  const r = spawnSync("bash", [join(dir, "TEST_INVENTORY.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, OUT: out, HOME: root } });
  return { r, out, root, calls: readFileSync(calls, "utf8") };
}

describe("TEST_INVENTORY.sh and check_inventory.py", () => {
  it("captures sanitized metadata with read-only calls only, and reports what is missing (the database was not read)", () => {
    const { r, out, calls, root } = run();
    try {
      expect(r.status, r.stderr + r.stdout).toBe(1);   // one check fails by design: no database connection was given
      expect(r.stdout).toContain("PASS TEST Handler targets ogevia_sv_test");
      expect(r.stdout).toContain("PASS TEST template has 259 routes (switch OFF)");
      expect(r.stdout).toMatch(/FAIL TEST ledger is 107\/0107 and 0109 is absent \(database not read\)/);
      for (const line of calls.trim().split("\n")) expect(line).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda get-function-configuration|apigatewayv2 get-routes|rds describe-db-instances)/);
      expect(calls).not.toMatch(/get-secret-value|secretsmanager|put-|update-|create-|delete-|deploy/);
      const template = readFileSync(join(out, "test-api-template.json"), "utf8");
      expect(template).not.toContain("super-secret"); expect(template).toContain("<REDACTED>");   // the redaction ran
      expect(readdirSync(out)).toContain("identity.json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stops before any other call when the AWS account is wrong", () => {
    const { r, calls, root } = run({ account: "111111111111" });
    try {
      expect(r.status).toBe(2); expect(r.stderr).toContain("wrong AWS account");
      expect(calls.trim().split("\n")).toEqual(["sts get-caller-identity --query Account --output text"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("the validator passes a complete good inventory and fails each wrong fact", () => {
    const { out, root } = run();
    try {
      const good = mkdtempSync(join(tmpdir(), "good-"));
      cpSync(out, good, { recursive: true });
      writeFileSync(join(good, "test-db.json"), JSON.stringify({ database: "ogevia_sv_test", ledger: "107/0107", probe: "ok" }));
      writeFileSync(join(good, "test-live-routes.json"), JSON.stringify(Array.from({ length: 260 }, (_, i) => `GET /v1/r${i}`)));
      const check = (d: string) => spawnSync("python3", [join(dir, "check_inventory.py"), d], { encoding: "utf8" });
      const ok = check(good); expect(ok.status, ok.stdout).toBe(0); expect(ok.stdout).toMatch(/\d+ of \d+ checks pass$/m);
      const damage = (file: string, edit: (j: any) => any, expectText: RegExp) => {
        const d = mkdtempSync(join(tmpdir(), "bad-")); cpSync(good, d, { recursive: true });
        writeFileSync(join(d, file), JSON.stringify(edit(JSON.parse(readFileSync(join(d, file), "utf8")))));
        const r2 = check(d); expect(r2.status, file).toBe(1); expect(r2.stdout).toMatch(expectText);
      };
      damage("test-handler.json", (j) => ({ ...j, dbName: "ogevia_prd" }), /FAIL TEST Handler targets ogevia_sv_test/);
      damage("test-handler.json", (j) => ({ ...j, dbHost: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com" }), /FAIL TEST Handler targets the expected database server/);
      damage("test-db.json", (j) => ({ ...j, ledger: "108/0109" }), /FAIL TEST ledger is 107\/0107/);
      damage("test-db.json", (j) => ({ ...j, probe: "failed" }), /FAIL migration 0109 probe/);
      damage("test-api-template.json", (j) => ({ Resources: { ...j.Resources, X: route("POST /v1/documents/{documentId}/cancel") } }), /FAIL TEST template has 259 routes|FAIL TEST template has none/);
      damage("rds.json", (j) => j.map((r: any) => (r.instance === "ogevia-postgres" ? { ...r, public: true } : r)), /FAIL RDS ogevia-postgres exists, available, private/);
      damage("test-web.json", (j) => ({ ...j, httpCode: "503" }), /FAIL TEST site answers 200/);
      damage("test-api-stack.json", (j) => ({ ...j, status: "UPDATE_IN_PROGRESS" }), /FAIL TEST API stack settled/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120000);
});
