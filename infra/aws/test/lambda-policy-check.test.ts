// The live Lambda-policy check (slice/lambda_policy_check.py and lambda-policy-check-readonly.sh): size AND principals. Synthetic policies and a fake AWS CLI only.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PY = fileURLToPath(new URL("../slice/lambda_policy_check.py", import.meta.url));
const SH = fileURLToPath(new URL("../slice/lambda-policy-check-readonly.sh", import.meta.url));
const ACCT = "300094796789", REGION = "us-west-2", API = "a1b2c3d4e5";
const FN = `arn:aws:lambda:${REGION}:${ACCT}:function:Ogevia-prod-ServiceVerificationApi-HandlerC405E486-AbCdEfGhIjKl`;
const RULE = "Ogevia-prod-ServiceVerificationApi-ComplianceSweep51D1109D-ABCDEFGH1234";
const api = (sid = "api-1", arn = `arn:aws:execute-api:${REGION}:${ACCT}:${API}/*/*/*`) =>
  ({ Sid: sid, Effect: "Allow", Principal: { Service: "apigateway.amazonaws.com" }, Action: "lambda:InvokeFunction", Resource: FN, Condition: { ArnLike: { "AWS:SourceArn": arn } } });
const ev = (sid = "ev-1", arn = `arn:aws:events:${REGION}:${ACCT}:rule/${RULE}`) =>
  ({ Sid: sid, Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "lambda:InvokeFunction", Resource: FN, Condition: { ArnLike: { "AWS:SourceArn": arn } } });
const doc = (...s: unknown[]) => JSON.stringify({ Version: "2012-10-17", Id: "default", Statement: s });

function check(policy: string, mode: "pre" | "post", extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "lpc-"));
  const f = join(dir, "policy.json");
  writeFileSync(f, policy);
  const r = spawnSync("python3", ["-I", PY, "--mode", mode, "--policy-file", f, "--function-arn", FN, "--account", ACCT, "--region", REGION, "--api-id", API, "--rule-name", RULE, ...extra], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("principals", () => {
  it("passes the synthesized shape: one API-wide statement before, plus exactly one events statement after", () => {
    expect(check(doc(api()), "pre").code).toBe(0);
    expect(check(doc(api(), ev()), "pre").code).toBe(0);
    const post = check(doc(api(), ev()), "post");
    expect(post.code, post.out).toBe(0);
    expect(post.out).toContain("PASS all checks (size and principals)");
  });
  it.each([
    ["a wildcard principal", { ...api(), Principal: "*" }],
    ["an account principal", { ...api(), Principal: { AWS: "arn:aws:iam::111122223333:root" } }],
    ["another service", { ...api(), Principal: { Service: "s3.amazonaws.com" } }],
    ["a list of services", { ...api(), Principal: { Service: ["apigateway.amazonaws.com", "events.amazonaws.com"] } }],
    ["a wildcard action", { ...api(), Action: "lambda:*" }],
    ["another action", { ...api(), Action: "lambda:GetFunction" }],
    ["another function", { ...api(), Resource: FN.replace("HandlerC405E486", "Other") }],
    ["a Deny", { ...api(), Effect: "Deny" }],
    ["NotPrincipal", { ...api(), NotPrincipal: { Service: "x.amazonaws.com" } }],
    ["no condition", (({ Condition, ...rest }) => rest)(api())],
    ["another API's source", api("api-1", `arn:aws:execute-api:${REGION}:${ACCT}:zzzzzzzzzz/*/*/*`)],
    ["a source in another account", api("api-1", `arn:aws:execute-api:${REGION}:111122223333:${API}/*/*/*`)],
    ["a source that is only a wildcard", api("api-1", "*")],
    ["a StringEquals condition instead of ArnLike", { ...api(), Condition: { StringEquals: { "AWS:SourceArn": `arn:aws:execute-api:${REGION}:${ACCT}:${API}/*/*/*` } } }],
  ])("fails %s", (_n, bad) => {
    const r = check(doc(api("ok"), bad), "pre");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("STOP");
  });
  it("fails an events statement for another rule, or a second one after the deployment, or none", () => {
    expect(check(doc(api(), ev("e", `arn:aws:events:${REGION}:${ACCT}:rule/SomethingElse`)), "pre").code).toBe(1);
    expect(check(doc(api(), ev("e1"), ev("e2")), "post").code).toBe(1);
    const none = check(doc(api()), "post");
    expect(none.code).toBe(1);
    expect(none.out).toContain("exactly one EventBridge statement");
  });
  it("fails a policy with no API Gateway statement, no statements, a wrong version, or unreadable JSON (exit 2)", () => {
    expect(check(doc(ev()), "pre").code).toBe(1);
    expect(check(JSON.stringify({ Version: "2012-10-17", Statement: [] }), "pre").code).toBe(1);
    expect(check(JSON.stringify({ Version: "2008-10-17", Statement: [api()] }), "pre").code).toBe(1);
    expect(check("not json", "pre").code).toBe(2);
  });
});

describe("size", () => {
  const perRoute = (n: number) => Array.from({ length: n }, (_, i) => api(`route-${i}`, `arn:aws:execute-api:${REGION}:${ACCT}:${API}/*/GET/v1/some/route/number/${i}`));
  it("reports the size and projected peak; the synthesized policy is about 1 KB or less", () => {
    const r = check(doc(api(), ev()), "post");
    expect(r.out).toMatch(/bytes now: \d+ \| largest statement: \d+ \| projected peak: \d+ \| limit 20480 \| gate 19000/);
    const bytes = Number(/bytes now: (\d+)/.exec(r.out)![1]);
    expect(bytes).toBeGreaterThan(700);
    expect(bytes).toBeLessThan(1500);
  });
  it("38 per-route statements (the pilot's earlier shape) pass with a peak far below the gate", () => {
    const r = check(doc(...perRoute(38)), "pre");
    expect(r.code, r.out).toBe(0);
  });
  it("fails when the projected peak reaches the gate, and when the policy is at or above the 20,480-byte limit", () => {
    const near = check(doc(...perRoute(50)), "pre");
    expect(near.code, near.out).toBe(1);
    expect(near.out).toContain("projected peak");
    const over = check(doc(...perRoute(60)), "pre");
    expect(over.code).toBe(1);
    expect(over.out).toContain("20480-byte limit");
  });
  it("after the deployment the size itself must stay below the gate", () => {
    const r = check(doc(...perRoute(52), ev()), "post");
    expect(r.code, r.out).toBe(1);
  });
});

describe("the read-only wrapper (fake AWS CLI)", () => {
  function fake(policy: string | null, opts: { rule?: boolean; apis?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "lpc-aws-"));
    const log = join(dir, "calls.log");
    const resources = [
      { ResourceType: "AWS::Lambda::Function", LogicalResourceId: "HandlerAB12", PhysicalResourceId: "fn-handler" },
      ...Array.from({ length: opts.apis ?? 1 }, () => ({ ResourceType: "AWS::ApiGatewayV2::Api", LogicalResourceId: "Api", PhysicalResourceId: API })),
      ...(opts.rule ? [{ ResourceType: "AWS::Events::Rule", LogicalResourceId: "ComplianceSweep", PhysicalResourceId: RULE }] : []),
    ];
    writeFileSync(join(dir, "policy.json"), policy ?? "");
    writeFileSync(join(dir, "aws"), `#!/usr/bin/env bash
echo "$1 $2" >> "${log}"
case "$1 $2" in
  "sts get-caller-identity") echo ${ACCT} ;;
  "cloudformation list-stack-resources") cat <<'JSON'
${JSON.stringify({ StackResourceSummaries: resources })}
JSON
  ;;
  "lambda get-function-configuration") echo "${FN}" ;;
  "lambda get-policy") ${policy === null ? 'echo "An error occurred (ResourceNotFoundException)" >&2; exit 254' : `cat "${join(dir, "policy.json")}"`} ;;
  *) echo "UNEXPECTED $1 $2" >> "${log}"; exit 99 ;;
esac
`);
    chmodSync(join(dir, "aws"), 0o755);
    const r = spawnSync("bash", [SH, ...(opts.rule ? ["post"] : ["pre"])], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    return { code: r.status, out: r.stdout + r.stderr, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
  }
  it("pre: passes on the synthesized shape and uses only get/list verbs", () => {
    const r = fake(doc(api()));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS all checks");
    expect(r.calls.every((c) => /^(sts get-caller-identity|cloudformation list-stack-resources|lambda get-function-configuration|lambda get-policy)$/.test(c))).toBe(true);
    expect(r.calls.join("|")).not.toContain("UNEXPECTED");
  });
  it("post: needs the rule in the stack and exactly one events statement", () => {
    expect(fake(doc(api(), ev()), { rule: true }).code).toBe(0);
    expect(fake(doc(api()), { rule: true }).code).toBe(1);
  });
  it("stops, changing nothing, when the policy is unreadable, a foreign principal is present, or the stack is ambiguous", () => {
    expect(fake(null).code).toBe(1);
    const bad = fake(doc(api(), { ...api("x"), Principal: "*" }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("STOP");
    expect(fake(doc(api()), { apis: 2 }).code).toBe(1);
  });
});
