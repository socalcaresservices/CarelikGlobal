// TEST_DB_SESSION.sh guard stages with a stand-in `aws` (the tunnel and the credential read are exercised only in CloudShell). Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../docs/releases/2026-11-20-test-plan/toolchain/TEST_DB_SESSION.sh", import.meta.url));
const HOST = "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com";

function run(scenario: { account?: string; host?: string; public?: boolean; groups?: string[]; secret?: string | null }, args: string[] = ["true"]) {
  const root = mkdtempSync(join(tmpdir(), "dbs-"));
  const calls = join(root, "calls"); writeFileSync(calls, "");
  const meta = { host: scenario.host ?? HOST, public: scenario.public ?? false, secret: scenario.secret === undefined ? "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-x" : scenario.secret, groups: scenario.groups ?? ["sg-0bc0f1315fd0feaf2"] };
  writeFileSync(join(root, "aws"), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a[:4] == ["--cli-connect-timeout", "5", "--cli-read-timeout", "30"]: a = a[4:]
open(${JSON.stringify(calls)}, "a").write(" ".join(a) + "\\n")
line = " ".join(a)
if "sts get-caller-identity" in line: print(${JSON.stringify(scenario.account ?? "300094796789")})
elif "rds describe-db-instances" in line: print(${JSON.stringify(JSON.stringify(meta))})
elif "ssm start-session" in line: sys.stderr.write("tunnel refused\\n"); sys.exit(1)
else: sys.stderr.write("UNEXPECTED AWS CALL " + line + "\\n"); sys.exit(9)
`);
  chmodSync(join(root, "aws"), 0o755);
  writeFileSync(join(root, "curl"), "#!/usr/bin/env bash\nout=''; while [[ $# -gt 0 ]]; do [[ \"$1\" == -o ]] && out=\"$2\"; shift; done; [[ -n \"$out\" ]] && echo pem > \"$out\"; exit 0\n"); chmodSync(join(root, "curl"), 0o755);
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, LOCAL_TUNNEL_PORT: "1" } });
  const log = readFileSync(calls, "utf8");
  rmSync(root, { recursive: true, force: true });
  return { r, log };
}
const neverReadSecret = (log: string) => expect(log).not.toMatch(/get-secret-value|secretsmanager/);

describe("TEST_DB_SESSION.sh guards", () => {
  it("needs a command to run", () => { const { r } = run({}, []); expect(r.status).toBe(2); expect(r.stderr).toContain("usage"); });

  it("stops on the wrong account before describing the database", () => {
    const { r, log } = run({ account: "111111111111" });
    expect(r.status).toBe(2); expect(r.stderr).toContain("wrong account");
    expect(log.trim().split("\n")).toEqual(["sts get-caller-identity --query Account --output text"]);
  });

  it("stops on a different host, a public instance, different security groups, or no managed secret, before any tunnel or credential", () => {
    for (const [scenario, text] of [
      [{ host: "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com" }, "host or privacy mismatch"],
      [{ public: true }, "host or privacy mismatch"],
      [{ groups: ["sg-0bc0f1315fd0feaf2", "sg-extra"] }, "security groups differ"],
      [{ secret: null }, "no managed master secret"],
    ] as const) {
      const { r, log } = run({ ...scenario });
      expect(r.status, JSON.stringify(scenario)).toBe(2); expect(r.stderr).toContain(text);
      expect(log).not.toContain("ssm start-session"); neverReadSecret(log);
    }
  });

  it("when every guard passes it tries the tunnel, and never reads the credential if the tunnel does not come up; the command does not run", () => {
    const { r, log } = run({}, ["bash", "-c", "echo SHOULD_NOT_RUN"]);
    expect(r.status).toBe(2); expect(r.stderr).toContain("the tunnel did not come up");
    expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(log).toContain("ssm start-session --target i-0ce8db2d7e5839dd5 --document-name AWS-StartPortForwardingSessionToRemoteHost");
    neverReadSecret(log);
    expect(log).not.toMatch(/ec2 (modify|authorize|attach)|security-group/);   // no security group is changed
  });
});
