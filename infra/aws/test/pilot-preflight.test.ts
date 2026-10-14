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
    expect([...probeCode.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g)].every((m) => m[1].startsWith("GET "))).toBe(true);
  });
  it("uses only the synthetic test identity and prints no identifiers", () => {
    expect(probe).toContain("a0000000-0000-4000-8000-0000000000a9");
    expect(probeCode).not.toMatch(/print\([^)]*organizationId|print\([^)]*\bsub\b/);
  });
});
