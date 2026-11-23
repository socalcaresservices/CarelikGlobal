import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh", import.meta.url));
function run(mode: string, scenario = "account", comparison = false) {
  const dir = mkdtempSync(join(tmpdir(), "isolated-operator-"));
  const log = join(dir, "calls"); writeFileSync(log, "");
  const put = (name: string, text: string) => { const file = join(dir, name); writeFileSync(file, text); chmodSync(file, 0o755); };
  put("git", '#!/usr/bin/env bash\n[[ "$*" == *rev-parse* ]] && echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexit 0\n');
  put("aws", `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == *get-caller-identity* ]]; then
  [[ "$SCENARIO" == account ]] && echo 111111111111 || echo 300094796789
elif [[ "$*" == *describe-db-instances* ]]; then
  echo '{"host":"ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com","public":false,"secret":"not-read","groups":[]}'
else echo 'UNEXPECTED AWS CALL' >&2; exit 9; fi
`);
  const target = comparison ? script.replace("OPERATOR_TEST_DB.sh", "OPERATOR_TEST_DEPLOY.sh") : script;
  const result = spawnSync("bash", [target.replaceAll("\\", "/"), mode], { encoding: "utf8", env: { ...process.env, PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, REPO: dir.replaceAll("\\", "/"), OGEVIA_RELEASE_COMMIT: "a".repeat(40), OGEVIA_ISOLATED_TEST_GO: "", SCENARIO: scenario, CALLS: log.replaceAll("\\", "/") } });
  return { ...result, calls: readFileSync(log, "utf8") };
}
describe("isolated database operator refusal guards", () => {
  it("initialization without a GO does not even call AWS", () => { const r = run("isolated-initialize"); expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("no explicit"); expect(r.calls).toBe(""); });
  it("an unknown mode does not call AWS", () => { const r = run("isolated-delete"); expect(r.status, r.stderr).toBe(2); expect(r.calls).toBe(""); });
  it("preflight refuses the wrong account before credentials or a tunnel", () => { const r = run("isolated-preflight"); expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("wrong account"); expect(r.calls).not.toMatch(/secretsmanager|ssm|modify|create/); });
  it("preflight refuses the production endpoint before credentials or a tunnel", () => { const r = run("isolated-preflight", "host"); expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("target host/privacy mismatch"); expect(r.calls).not.toMatch(/secretsmanager|ssm|modify|create/); });
  it("deployment comparison refuses the wrong account before capture or mutations", () => { const r = run("isolated-compare", "account", true); expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("wrong account"); expect(r.calls).not.toMatch(/get-secret|ssm|modify|create|update|deploy/); });
  it("discovers the Handler from aggregated JSON without paginated None placeholders, and refuses ambiguity", () => {
    const text = readFileSync(script.replace("OPERATOR_TEST_DB.sh", "OPERATOR_TEST_DEPLOY.sh"), "utf8");
    const query = /FN=\$\(A cloudformation list-stack-resources[^\n]+jq -er '([^']+)'/.exec(text)![1]!;
    const handler = { ResourceType: "AWS::Lambda::Function", LogicalResourceId: "Handler886CB40B", PhysicalResourceId: "test-handler" };
    const call = (resources: unknown[]) => spawnSync("jq", ["-er", query], { input: JSON.stringify({ StackResourceSummaries: resources }), encoding: "utf8" });
    const one = call([{ ResourceType: "AWS::IAM::Role", LogicalResourceId: "Other", PhysicalResourceId: "role" }, handler]);
    expect(one.status, one.stderr).toBe(0); expect(one.stdout.trim()).toBe("test-handler");
    expect(call([handler, handler]).status).not.toBe(0);
  });
});
