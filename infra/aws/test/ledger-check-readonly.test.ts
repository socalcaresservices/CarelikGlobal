// The ledger check must stay read-only. STATIC check: every aws call is describe-/list-/get-, with exactly two audited exceptions
// (start-session, get-secret-value); it cannot change a security group, stack, Lambda, secret or database object; it proves the
// database name before querying and refuses to guess an environment. (It cannot prove what AWS does.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../slice/ledger-check-readonly.sh", import.meta.url), "utf8");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("ledger-check-readonly.sh", () => {
  it("every aws command is a read verb, plus the two audited exceptions", () => {
    const calls = [...code.matchAll(/\baws\s+(sts|cloudformation|lambda|rds|ec2|ssm|secretsmanager)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) expect(c, c).toMatch(/^[a-z0-9-]+ (describe-|list-|get-|start-session$)/);
    expect(calls.filter((c) => c.startsWith("secretsmanager"))).toEqual(["secretsmanager get-secret-value"]);
    expect(calls.filter((c) => c.startsWith("ssm"))).toEqual(["ssm start-session"]);
  });
  it("cannot change a security group, stack, function, secret, snapshot or deployment", () => {
    for (const bad of [/modify-/, /attach-/, /detach-/, /authorize-/, /revoke-/, /create-/, /delete-/, /update-/, /\bput-/, /\binvoke\b/, /\bcdk\b/, /\bsync\b/, /terminate/, /\bstop-/, /\bstart-instances/, /db:migrate/, /\bsed -i/, /dnf install/, /sudo/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
  });
  it("runs SQL only as read-only, and the only SQL statements are selects", () => {
    expect(code).toContain("default_transaction_read_only=on");
    expect(code).toContain("begin transaction read only");
    const sql = [...code.matchAll(/-c "([^"]+)"/g)].map((m) => m[1]!.trim().toLowerCase());
    expect(sql.length).toBeGreaterThan(4);
    for (const s of sql) expect(s, s).toMatch(/^(select|begin transaction read only|rollback)\b/);
    for (const bad of [/\binsert\b/, /\bupdate\b/, /\bdelete\b/, /\bdrop\b/, /\balter\b/, /\bcreate\b/, /\btruncate\b/, /\bgrant\b/]) expect(code.replace(/#.*$/gm, "")).not.toMatch(new RegExp(`-c "[^"]*${bad.source}`));
  });
  it("names each environment explicitly and checks the database before querying", () => {
    expect(code).toContain("ogevia_sv_test");
    expect(code).toContain("ogevia_prd");
    expect(code).toContain("Ogevia-prod-ServiceVerificationApi");
    expect(code).toContain("Ogevia-prd-ServiceVerificationApi");
    expect(code).toContain("select current_database()");
    expect(code.indexOf("select current_database()")).toBeLessThan(code.indexOf("from ogevia_meta.schema_migrations where version >= '0053'"));
    expect(code).toMatch(/usage: bash ledger-check-readonly\.sh test\|prod/);
  });
  it("never prints a credential or writes outside its own folder", () => {
    expect(code).not.toMatch(/echo[^\n]*PGPASSWORD|printf[^\n]*PGPASSWORD|set -x|say[^\n]*SEC\b/);
    const targets = [...code.matchAll(/(?:^|[^-<>=\d])\d?>>?\s*([^\s&|;)]+)/gm)].map((m) => m[1]!.replace(/^"|"$/g, "")).filter((x) => !/^\d+$/.test(x) && x !== "/dev/null" && !x.startsWith("/dev/tcp/") && !/[`'=]/.test(x) && x !== "=");
    for (const x of targets) expect(x, x).toMatch(/^\$RESULT$|^\$OUT\//);
  });
  it("stops, rather than changes anything, when the admin host cannot already reach the database", () => {
    expect(code).toContain("cannot read the ledger without a temporary security-group change");
    expect(code).not.toMatch(/modify-instance-attribute/);
  });
});
