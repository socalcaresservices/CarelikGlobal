import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

// The follow-up gate (web_headers_gate.py). LIVE = the templates deployed by the authentication release (fixtures/auth-separation/deployed, synthesized from commit 9e8582b);
// NEW = what this code synthesizes. The real run compares the owner's actual live templates; this proves it accepts exactly one header change and nothing else.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const GATE = fileURLToPath(new URL("../../../docs/releases/2026-10-21-auth-separation/scripts/web_headers_gate.py", import.meta.url));
const DEPLOYED = fileURLToPath(new URL("./fixtures/auth-separation/deployed", import.meta.url));
const SHARED = ENVIRONMENTS.prod.existing.cognitoUserPoolId;
const work = mkdtempSync(join(tmpdir(), "webhdr-")), NEW = join(work, "new");
const WEB = "Ogevia-prd-WebHosting";
const read = (dir: string, s: string) => JSON.parse(readFileSync(join(dir, `${s}.json`), "utf8"));
const write = (dir: string, s: string, t: unknown) => writeFileSync(join(dir, `${s}.json`), JSON.stringify(t));
const gate = (live: string, next: string) => { const r = spawnSync("python3", ["-I", "-B", GATE, "--live-dir", live, "--new-dir", next, "--shared-pool", SHARED], { encoding: "utf8" }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
const cspOf = (t: any) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::CloudFront::ResponseHeadersPolicy")!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
function variant(name: string, fn: (d: { live: string; next: string }) => void) {
  const live = join(work, `${name}-live`), next = join(work, `${name}-new`);
  cpSync(DEPLOYED, live, { recursive: true }); cpSync(NEW, next, { recursive: true }); fn({ live, next });
  return gate(live, next);
}

beforeAll(() => {
  mkdirSync(NEW, { recursive: true });
  for (const env of ["prd", "prod"] as const) {
    for (const p of buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan")) {
      if (env === "prod" && p.stack.stackName !== "Ogevia-prod-NetworkEgress") continue;
      write(NEW, p.stack.stackName, Template.fromStack(p.stack).toJSON());
    }
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("web-headers gate (follow-up: the website's security header allows production's sign-in domain)", () => {
  it("PASSES on the deployed state vs the new templates: one header value changes, nothing else", () => {
    const r = gate(DEPLOYED, NEW);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("PASS"); expect(r.out).toContain("ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com");
  });

  it("the live fixture really carries the OLD header (the shared pilot domain only) and the new templates carry the dedicated one", () => {
    expect(cspOf(read(DEPLOYED, WEB)).ContentSecurityPolicy).toContain("us-west-2849ayz5j7");
    expect(cspOf(read(DEPLOYED, WEB)).ContentSecurityPolicy).not.toContain("ogevia-prd-300094796789");
    expect(cspOf(read(NEW, WEB)).ContentSecurityPolicy).toContain("ogevia-prd-300094796789");
    expect(cspOf(read(NEW, WEB)).ContentSecurityPolicy).not.toContain("us-west-2849ayz5j7");
  });

  it("REFUSES when nothing would change (already applied)", () => {
    const r = variant("applied", ({ live, next }) => { write(live, WEB, read(next, WEB)); });
    expect(r.code).toBe(1); expect(r.out).toContain("exactly ONE security-header change");
  });

  it("REFUSES a widened header, a different domain, an http origin, or an extra directive change", () => {
    const edit = (name: string, f: (v: string) => string) => variant(name, ({ next }) => { const t = read(next, WEB); const c = cspOf(t); c.ContentSecurityPolicy = f(c.ContentSecurityPolicy); write(next, WEB, t); });
    for (const [n, f] of [
      ["wide", (v: string) => v.replace("connect-src 'self'", "connect-src 'self' https://*.amazoncognito.com")],
      ["other-domain", (v: string) => v.replaceAll("ogevia-prd-300094796789", "ogevia-prd-999999999999")],
      ["http", (v: string) => v.replaceAll("https://ogevia-prd-300094796789", "http://ogevia-prd-300094796789")],
      ["script", (v: string) => v.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")],
      ["shared-kept", (v: string) => v.replace("form-action 'self'", "form-action 'self' https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com")],
    ] as const) { const r = edit(n, f); expect(r.code, n).toBe(1); expect(r.out, n).toContain("differs from live in a way this change does not allow"); }
  });

  it("REFUSES any difference in the other six stacks (API, Auth, database secret, evidence, observability, network egress)", () => {
    for (const s of ["Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Auth", "Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"]) {
      const r = variant(`drift-${s}`, ({ live }) => { const t = read(live, s); t.Description = "someone changed this"; write(live, s, t); });
      expect(r.code, s).toBe(1); expect(r.out, s).toContain(`${s}: differs from live`);
    }
  });

  it("REFUSES a missing template on either side, and a live stack that still imports the old client's export", () => {
    const missing = variant("missing", ({ live }) => rmSync(join(live, `${WEB}.json`)));
    expect(missing.code).toBe(1); expect(missing.out).toContain("missing");
    const imp = variant("import", ({ live, next }) => {
      for (const d of [live, next]) { const t = read(d, "Ogevia-prd-Observability"); t.Resources.X = { Type: "AWS::SSM::Parameter", Properties: { Type: "String", Value: { "Fn::ImportValue": "Ogevia-prd-WebHosting:ExportsOutputRefTestSliceAppClient5EA2F71F" } } }; write(d, "Ogevia-prd-Observability", t); }
    });
    expect(imp.code).toBe(1); expect(imp.out).toContain("still imported by");
  });
});
