// The read-only pilot preflight must stay read-only. This is a STATIC check of the two files an operator will run in AWS
// CloudShell: every `aws` call is a describe-, list-, get- or head- call, the script cannot write, read a secret, open a
// tunnel or touch the database, and the Lambda probe sends only GET routes. (It cannot prove what AWS does; it stops the
// scripts from quietly gaining a write.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../slice/pilot-preflight-readonly.sh", import.meta.url), "utf8");
const probe = readFileSync(new URL("../slice/pilot_preflight_probe.py", import.meta.url), "utf8");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const probeCode = probe.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/"""[\s\S]*?"""/g, "");

describe("pilot-preflight-readonly.sh", () => {
  it("every aws command is a read-only verb", () => {
    const calls = [...code.matchAll(/\baws\s+(sts|cloudformation|lambda|apigatewayv2|s3api|cloudfront|rds|ec2|ssm|secretsmanager|iam|cognito-idp|s3|kms|logs)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) expect(c, c).toMatch(/^[a-z0-9-]+ (describe-|list-|get-|head-)/);
  });
  it("contains no write, secret, tunnel, database or deploy command", () => {
    for (const bad of [
      /create-/, /delete-/, /update-/, /modify-/, /\bput-/, /start-session/, /get-secret-value/, /\binvoke\b/, /\bsync\b/, /\bpsql\b/,
      /\bcdk\b/, /terminate/, /\bstop-/, /\bstart-/, /attach-/, /detach-/, /authorize-/, /revoke-/, /\brm\s/, /\bcp\s/, /\bmv\s/,
      /db:migrate/, /--region\s+(?!\$)/, /\bsed -i/, /\btee\s+\/(?!dev)/,
    ]) expect(code, String(bad)).not.toMatch(bad);
  });
  it("only ever writes inside its own output folder", () => {
    const targets = [...code.matchAll(/(?:^|[^-<>=\d])\d?>>?\s*([^\s&|;)]+)/gm)].map((m) => m[1]!.replace(/^"|"$/g, "")).filter((x) => !/^\d+$/.test(x) && x !== "/dev/null");
    expect(targets.length).toBeGreaterThan(5);
    for (const x of targets) expect(x, x).toMatch(/^\$OUT\/|^\$SUMMARY$/);
  });
  it("targets the pilot only and refuses production", () => {
    expect(code).toContain("Ogevia-prod-");
    expect(code).not.toMatch(/Ogevia-prd/);
    expect(code).toContain("ogevia_sv_test");
    expect(script).toMatch(/OGEVIA_ENV is prd: STOP/);
  });
  it("lists what it excludes, so the operator can see the boundary", () => {
    for (const w of ["create-db-snapshot", "modify-instance-attribute", "get-secret-value", "start-session"]) expect(script).toContain(w);
  });
});

describe("pilot_preflight_probe.py", () => {
  it("sends only GET routes", () => {
    const calls = [...probeCode.matchAll(/inv\.call\(\s*("[^"]+"|route)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(2);
    expect(probeCode).not.toMatch(/"(POST|PUT|PATCH|DELETE) \//);
    expect([...probeCode.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g)].every((m) => m[1]!.startsWith("GET "))).toBe(true);
  });
  it("uses only the synthetic test identity and prints no identifiers", () => {
    expect(probe).toContain("a0000000-0000-4000-8000-0000000000a9");
    expect(probeCode).not.toMatch(/print\([^)]*organizationId|print\([^)]*\bsub\b/);
  });
});

// Behaviour test for the Lambda discovery that crashed in the first live preflight (IndexError on fns[0]).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const slice = fileURLToPath(new URL("../slice/", import.meta.url));
const discover = (resources: unknown[]): { fn?: string; error?: string; verb?: string } =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `import json,sys
sys.path.insert(0, ${JSON.stringify(slice)})
import smoke
calls = []
def fake(*a):
    calls.append(a[1])
    return {"StackResourceSummaries": json.loads(sys.argv[1])}
smoke.aws = fake
try:
    print(json.dumps({"fn": smoke.find_api_function(), "verb": calls[0]}))
except RuntimeError as e:
    print(json.dumps({"error": str(e), "verb": calls[0]}))
`,
        JSON.stringify(resources),
      ],
      { encoding: "utf8" },
    ),
  );
const lambda = (logical: string, physical: string) => ({ LogicalResourceId: logical, PhysicalResourceId: physical, ResourceType: "AWS::Lambda::Function" });

describe("smoke.find_api_function (preflight Lambda discovery)", () => {
  it("picks the Handler Lambda, not the first Lambda, and reads with list-stack-resources", () => {
    const r = discover([
      { LogicalResourceId: "Api", PhysicalResourceId: "x", ResourceType: "AWS::ApiGatewayV2::Api" },
      lambda("CustomLogRetention1", "helper-fn"),
      lambda("IdentityHandler", "identity-fn"),
      lambda("Handler886CB40B", "api-handler-fn"),
    ]);
    expect(r.fn).toBe("api-handler-fn");
    expect(r.verb).toBe("list-stack-resources");
  });
  it("stops with a message that says what was found when there is no Lambda (was: IndexError)", () => {
    const r = discover([{ LogicalResourceId: "Api", PhysicalResourceId: "x", ResourceType: "AWS::ApiGatewayV2::Api" }]);
    expect(r.fn).toBeUndefined();
    expect(r.error).toMatch(/cannot identify the API handler Lambda in stack Ogevia-prod-ServiceVerificationApi: 1 resources listed, 0 Lambda functions/);
  });
  it("stops when the handler is ambiguous or missing though other Lambdas exist", () => {
    expect(discover([lambda("IdentityHandler", "i")]).error).toMatch(/1 Lambda functions \(IdentityHandler\), 0 match/);
    expect(discover([lambda("HandlerA", "a"), lambda("HandlerB", "b")]).error).toMatch(/2 match/);
  });
});
