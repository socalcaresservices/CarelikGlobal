// The request-cleanup API gate, driven by the REAL synthesized isolated-TEST templates (switch OFF and ON) plus damaged copies. Nothing touches AWS.
import { Template } from "aws-cdk-lib/assertions";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, resolveTestDatabase } from "../lib/config.js";
import { newApp } from "./helpers.js";

const MASTER = "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-11111111-2222-3333-4444-555555555555-AbCdEf";
const gate = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/diff_gate_0109.py", import.meta.url));
const api = (config: any) => {
  const out = Object.fromEntries(buildOgeviaApp(newApp({ pathMetadata: true }), config).map(({ stack }) => [stack.stackName, Template.fromStack(stack).toJSON()])) as Record<string, any>;
  return out["Ogevia-prod-ServiceVerificationApi"];
};
const routeKeys = (t: any) => Object.values<any>(t.Resources).filter((r) => r.Type === "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey as string);

describe("diff_gate_0109.py", () => {
  it("accepts exactly the reviewed differences and refuses everything else", () => {
    const off = resolveTestDatabase(ENVIRONMENTS.prod, "isolated", MASTER);
    const live = api(off);                                                          // today's TEST: switch off
    const on = api({ ...off, features: { ...off.features, requestCleanup: true } });
    expect(routeKeys(live)).toHaveLength(259); expect(routeKeys(on)).toHaveLength(262);
    const dir = mkdtempSync(join(tmpdir(), "gate-0109-"));
    const write = (name: string, t: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(t)); return f; };
    const run = (liveF: string, newF: string, expect_: string) => spawnSync("python3", [gate, "--live", liveF, "--new", newF, "--expect", expect_], { encoding: "utf8" });
    try {
      const L = write("live.json", live), ON = write("on.json", on);
      // identical templates
      expect(run(L, L, "post").status).toBe(0);
      expect(run(L, L, "off").status).toBe(0);
      expect(run(L, L, "on").status).toBe(1);                                      // the three routes are missing
      // switch ON adds exactly three routes
      const added = run(L, ON, "on"); expect(added.status, added.stdout).toBe(0); expect(added.stdout).toContain("EXPECTED-ONLY: YES (on)");
      expect(run(L, ON, "off").status).toBe(1);                                    // routes must not appear with the switch off
      expect(run(L, ON, "post").status).toBe(1);
      // a new Handler code asset is the only allowed change with the switch off
      const handlerId = Object.keys(live.Resources).find((k) => k.startsWith("Handler") && live.Resources[k].Type === "AWS::Lambda::Function")!;
      const newCode = structuredClone(live);
      newCode.Resources[handlerId].Properties.Code = { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: "new-asset.zip" };
      newCode.Resources[handlerId].Metadata = { ...newCode.Resources[handlerId].Metadata, "aws:asset:path": "asset.new" };
      const liveCode = structuredClone(live);
      liveCode.Resources[handlerId].Properties.Code = { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: "old-asset.zip" };
      const codeOnly = run(write("live-code.json", liveCode), write("new-code.json", newCode), "off");
      expect(codeOnly.status, codeOnly.stdout).toBe(0); expect(codeOnly.stdout).toContain("Handler code asset changed");
      expect(run(write("live-code.json", liveCode), write("new-code.json", newCode), "post").status).toBe(1);
      // a code asset from any other bucket is refused
      const strange = structuredClone(newCode); strange.Resources[handlerId].Properties.Code.S3Bucket = "some-other-bucket";
      expect(run(write("live-code.json", liveCode), write("strange.json", strange), "off").status).toBe(1);
      // any other change is refused: an environment variable, a removed route, an extra route, an IAM statement
      const env = structuredClone(live); env.Resources[handlerId].Properties.Environment.Variables.DB_NAME = "ogevia_prd";
      expect(run(L, write("env.json", env), "off").status).toBe(1);
      const removed = structuredClone(live); delete removed.Resources[Object.keys(removed.Resources).find((k) => removed.Resources[k].Type === "AWS::ApiGatewayV2::Route")!];
      expect(run(L, write("removed.json", removed), "off").status).toBe(1);
      const extra = structuredClone(on); const first = Object.keys(extra.Resources).find((k) => extra.Resources[k].Type === "AWS::ApiGatewayV2::Route" && !routeKeys(live).includes(extra.Resources[k].Properties.RouteKey))!;
      extra.Resources["ExtraRoute"] = { ...structuredClone(extra.Resources[first]), Properties: { ...extra.Resources[first].Properties, RouteKey: "POST /v1/not-reviewed" } };
      expect(run(L, write("extra.json", extra), "on").status).toBe(1);
      const policy = structuredClone(live); const pid = Object.keys(policy.Resources).find((k) => k.startsWith("HandlerPolicy"))!;
      policy.Resources[pid].Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" });
      expect(run(L, write("policy.json", policy), "off").status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240000);
});
