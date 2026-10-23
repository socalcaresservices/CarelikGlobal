// slice/db-window-run.sh, rehearsed WITHOUT AWS: (1) the real script against a real local PostgreSQL through its rehearsal-only local URL, and
// (2) the window logic against a fake AWS CLI, psql and session-manager-plugin. SYNTHETIC values only.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";
import { ADMIN_URL, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const SCRIPT = join(__dirname, "../../slice/db-window-run.sh");
const url = (database: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const sh = (args: string[], env: Record<string, string>, input = "") =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", input, env: { ...process.env, HOME: env.OGEVIA_DBRUN_OUT ?? tmpdir(), ...env } });

describe("db-window-run.sh against a local PostgreSQL (local rehearsal mode)", () => {
  let db: TestDb;
  let w: World;
  let slug = "";
  let out = "";
  const env = () => ({ OGEVIA_DBRUN_LOCAL_URL: url(db.name), OGEVIA_ORG_SLUG: slug, OGEVIA_DBRUN_OUT: out });
  const count = async () => Number((await db.admin.query("select count(*) n from ogevia.clients where organization_id = $1", [w.orgA])).rows[0].n);
  const SNAP = "ogevia-prod-postgres-pre-testdata-202610230000";

  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
    slug = (await db.admin.query("select slug from ogevia.organizations where id = $1", [w.orgA])).rows[0].slug;
    await db.admin.query("update ogevia.clients set status = 'inactive' where organization_id = $1", [w.orgA]); // the cleanup only clears inactive clients
    out = mkdtempSync(join(tmpdir(), "dbrun-"));
  });
  afterAll(async () => db?.drop());

  it("prints usage and changes nothing without a valid environment or action", () => {
    expect(sh([], env()).status).toBe(2);
    expect(sh(["prd", "nonsense"], env()).status).toBe(2);
    expect(sh(["staging", "preview"], env()).status).toBe(2);
  });

  it("preview: runs the count-only script, saves the output, changes nothing", async () => {
    const before = await count();
    const r = sh(["prd", "preview"], env());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("== A. Agency and people that stay");
    expect(r.stdout).toContain("Preview saved:");
    expect(await count()).toBe(before);
  });

  it("dashboard: prints the Home figures read-only as the owner, and saves them", () => {
    const r = sh(["prd", "dashboard"], env());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("== Home tiles: the numbers on the dashboard cards ==");
    expect(r.stdout).toContain("== Home: Hours this month");
    expect(r.stdout).toContain("Dashboard figures saved:");
  });

  it("clear-dry-run: needs a numeric expected count; a wrong count is refused; the right one reports and rolls back", async () => {
    const before = await count();
    expect(sh(["prd", "clear-dry-run"], env()).status).not.toBe(0);
    expect(sh(["prd", "clear-dry-run", "abc"], env()).status).not.toBe(0);
    const wrong = sh(["prd", "clear-dry-run", String(before + 1)], env());
    expect(wrong.status).not.toBe(0);
    const ok = sh(["prd", "clear-dry-run", String(before)], env());
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("DRY RUN");
    expect(await count()).toBe(before);
  });

  it("clear-apply: refuses a malformed snapshot id and a wrong typed phrase; applies only with the exact phrase", async () => {
    const before = await count();
    const bad = sh(["prd", "clear-apply", String(before), "not-a-snapshot"], env(), `CLEAR-${slug}-${before}\n`);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/must look like ogevia-prod-postgres-pre-testdata/);
    expect(await count()).toBe(before);
    const declined = sh(["prd", "clear-apply", String(before), SNAP], env(), "yes\n");
    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain("Declined. Nothing was changed.");
    expect(await count()).toBe(before);
    const applied = sh(["prd", "clear-apply", String(before), SNAP], env(), `CLEAR-${slug}-${before}\n`);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain("APPLIED");
    expect(await count()).toBe(before); // option 1: the client rows stay (the cleanup removes their linked test records, not the clients)
  });
});

describe("db-window-run.sh: verify-new-agencies is TEST only", () => {
  const TEST = "ogevia_sv_test";
  beforeAll(async () => {
    assertSafeTarget(ADMIN_URL);
    const c = new pg.Client({ connectionString: url("postgres") });
    await c.connect();
    await c.query(`drop database if exists ${TEST} with (force)`);
    await c.query(`create database ${TEST}`);
    await c.end();
    const t = new pg.Client({ connectionString: url(TEST) });
    await t.connect();
    await migrate(t);
    await t.end();
  });
  afterAll(async () => {
    const c = new pg.Client({ connectionString: url("postgres") });
    await c.connect();
    await c.query(`drop database if exists ${TEST} with (force)`);
    await c.end();
  });
  it("runs the three checks for test, and refuses for prd", () => {
    const out = mkdtempSync(join(tmpdir(), "dbrun-"));
    const ok = sh(["test", "verify-new-agencies"], { OGEVIA_DBRUN_LOCAL_URL: url(TEST), OGEVIA_DBRUN_OUT: out });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    for (const p of ["PASS 1:", "PASS 2:", "PASS 3:", "ROLLED BACK"]) expect(ok.stdout, p).toContain(p);
    const no = sh(["prd", "verify-new-agencies"], { OGEVIA_DBRUN_LOCAL_URL: url(TEST), OGEVIA_DBRUN_OUT: out });
    expect(no.status).not.toBe(0);
    expect(no.stdout).toContain("TEST only");
  });
});

describe("db-window-run.sh window logic against a fake AWS CLI", () => {
  const ORIGINAL = "sg-00e01e2ca80442c1f";
  const APP = "sg-064ffce3bcbe8eb3b";
  let dir = "";
  const fakeBin = (d: string) => {
    const bin = join(d, "bin");
    mkdirSync(bin, { recursive: true });
    const put = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    put("aws", `D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"; svc="$1"; verb="$2"
case "$svc $verb" in
  "sts get-caller-identity") echo 300094796789 ;;
  "rds describe-db-instances") echo '{"DBInstanceStatus":"available","Endpoint":{"Address":"db.example.internal"},"MasterUserSecret":{"SecretArn":"arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-x"}}' ;;
  "ec2 describe-instances") if [[ "$*" == *"--instance-ids"* ]]; then cat "$D/sgs"; else echo i-0ce8db2d7e5839dd5; fi ;;
  "ec2 modify-instance-attribute") g=$(sed 's/.*--groups //' <<<"$*"); echo "$g" > "$D/sgs"; echo "MODIFY $g" >> "$D/events.log" ;;
  "ssm start-session") echo TUNNEL >> "$D/events.log"; exec python3 -c "import socket,time,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5); time.sleep(120)" "$MOCK_PORT" ;;
  "secretsmanager get-secret-value") echo '{"username":"mockadmin","password":"SECRET-PW-CANARY"}' ;;
  *) echo "UNEXPECTED $svc $verb" >> "$D/events.log"; exit 99 ;;
esac`);
    put("psql", `D="$MOCK_DIR"; echo "PSQL host=$PGHOST port=$PGPORT user=$PGUSER pwset=\${PGPASSWORD:+yes} args=$*" >> "$D/events.log"
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: error" >&2; exit 2; }
[[ "$*" == *"current_database"* ]] && { echo "\${MOCK_DB:-ogevia_prd}"; exit 0; }
echo "== A. Agency and people that stay (PRESERVED) =="; exit 0`);
    put("session-manager-plugin", "exit 0");
    put("pkill", "exit 0");
    return bin;
  };
  const go = (action: string[], extra: Record<string, string> = {}) => {
    const d = mkdtempSync(join(tmpdir(), "fakeaws-"));
    dir = d;
    writeFileSync(join(d, "sgs"), `${ORIGINAL}\n`);
    const bin = fakeBin(d);
    const r = spawnSync("bash", [SCRIPT, "prd", ...action], {
      encoding: "utf8", input: "", timeout: 90_000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, MOCK_DIR: d, MOCK_PORT: "15499", OGEVIA_DBRUN_LOCAL_PORT: "15499", OGEVIA_DBRUN_OUT: join(d, "out"), OGEVIA_SQL_DIR: "", ...extra },
    });
    const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : "");
    return { r, events: read("events.log"), sgs: read("sgs").trim(), log: [r.stdout, r.stderr, ...["out"].map(() => "")].join("\n") };
  };

  it("attaches the application group before the tunnel, queries as the master, then restores and verifies the original groups", () => {
    const { r, events, sgs } = go(["preview"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const order = events.split("\n").filter(Boolean);
    expect(order[0]).toBe(`MODIFY ${ORIGINAL} ${APP}`);
    expect(order[1]).toBe("TUNNEL");
    expect(order.some((l) => l.startsWith("PSQL host=127.0.0.1") && l.includes("pwset=yes"))).toBe(true);
    expect(order[order.length - 1]).toBe(`MODIFY ${ORIGINAL}`);
    expect(sgs).toBe(ORIGINAL);
    expect(r.stdout).toContain("Verified: admin host security groups are the original");
    expect(`${r.stdout}${r.stderr}`).not.toContain("SECRET-PW-CANARY");
  });

  it("restores the original groups even when the database step fails", () => {
    const { r, events, sgs } = go(["preview"], { MOCK_PSQL_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(events).toContain(`MODIFY ${ORIGINAL} ${APP}`);
    expect(sgs).toBe(ORIGINAL);
    expect(r.stdout).toContain("Verified: admin host security groups are the original");
    expect(`${r.stdout}${r.stderr}`).not.toContain("SECRET-PW-CANARY");
  });

  it("stops without changing anything if it connects to the wrong database", () => {
    const { r, sgs } = go(["preview"], { MOCK_DB: "ogevia_sv_test" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/connected to 'ogevia_sv_test', expected 'ogevia_prd'/);
    expect(sgs).toBe(ORIGINAL);
  });

  it("stops if a previous window was left open (the application group is already attached)", () => {
    const d = mkdtempSync(join(tmpdir(), "fakeaws-"));
    dir = d;
    writeFileSync(join(d, "sgs"), `${ORIGINAL} ${APP}\n`);
    const bin = fakeBin(d);
    const r = spawnSync("bash", [SCRIPT, "prd", "preview"], {
      encoding: "utf8", input: "", timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, MOCK_DIR: d, MOCK_PORT: "15498", OGEVIA_DBRUN_LOCAL_PORT: "15498", OGEVIA_DBRUN_OUT: join(d, "out") },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/previous window was left open/);
    expect(existsSync(join(d, "events.log")) ? readFileSync(join(d, "events.log"), "utf8") : "").not.toContain("MODIFY");
  });
});
