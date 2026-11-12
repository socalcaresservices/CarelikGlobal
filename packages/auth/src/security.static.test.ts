// @vitest-environment node
// Static guards over the auth package source (tests and fixtures excluded).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname);
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
// Comments are stripped so prose like "never localStorage" does not count as use.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = files(root).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: stripComments(readFileSync(path, "utf8")) }));

describe("auth package static security", () => {
  it("scans real source files", () => {
    expect(sources.map((s) => s.path)).toEqual(expect.arrayContaining(["cognito/client.ts", "server/principal.ts", "auth-provider.tsx"]));
  });

  it("never uses localStorage", () => {
    for (const s of sources) expect(s.text, s.path).not.toMatch(/localStorage/);
  });

  it("never sends or stores a client secret", () => {
    for (const s of sources) expect(s.text, s.path).not.toMatch(/client_secret|clientSecret/);
  });

  it("Cognito and server code never write to the console", () => {
    for (const s of sources.filter((x) => x.path.startsWith("cognito/") || x.path.startsWith("server/"))) {
      expect(s.text, s.path).not.toMatch(/console\./);
    }
  });

  it("console calls elsewhere never pass token, session or error objects", () => {
    for (const s of sources) {
      for (const line of s.text.split("\n").filter((l) => /console\./.test(l))) {
        // Arguments after the leading message literal: only `.message` of an error is allowed.
        const args = line.replace(/^.*console\.\w+\(\s*"[^"]*"\s*,?/, "");
        expect(args, s.path).not.toMatch(/token|session|password|\b(error|err|e)\s*[,)]/i);
      }
    }
  });

  it("contains no AWS credentials, private keys or JWT-looking literals", () => {
    for (const s of sources) {
      expect(s.text, s.path).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
    }
  });

  it("does not hard-code a live pool or app client (configuration is injected)", () => {
    for (const s of sources) expect(s.text, s.path).not.toMatch(/us-west-2_849AYz5J7|1i27abbina08fvg1i9u8vprgo9/);
  });

  it("server principal never reads groups, email or custom org/role claims", () => {
    const principal = sources.find((s) => s.path === "server/principal.ts")!.text;
    expect(principal).not.toMatch(/cognito:groups|claims\.email|custom:|organization_id|claims\.role/);
  });
});
