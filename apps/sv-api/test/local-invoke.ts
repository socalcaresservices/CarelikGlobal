// TEST TOOL: runs ONE API-Gateway-shaped event (stdin) through the real handler
// against a LOCAL database and prints the response JSON. Used to test
// infra/aws/slice/smoke.py without AWS. Evidence is stored as versioned files
// under OGEVIA_LOCAL_EVIDENCE_DIR so separate invocations share it.
//   tsx test/local-invoke.ts            < event.json
//   tsx test/local-invoke.ts age <visitId> <minutes>
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createHandler } from "../src/handler";
import type { EvidenceStore } from "../src/evidence";

const url = process.env.OGEVIA_LOCAL_DB_URL ?? "";
const host = new URL(url).hostname;
if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("local-invoke only targets a local database");

const dir = process.env.OGEVIA_LOCAL_EVIDENCE_DIR ?? "/tmp/ogevia-local-evidence";
const fileStore: EvidenceStore = {
  async put(key, bytes, sha256) {
    if (!createHash("sha256").update(bytes).digest().equals(sha256)) throw new Error("checksum mismatch");
    const d = join(dir, key.replace(/\//g, "_"));
    mkdirSync(d, { recursive: true });
    const versionId = `v${readdirSync(d).length + 1}`;
    writeFileSync(join(d, versionId), bytes);
    return { versionId };
  },
  async get(key, versionId) {
    const d = join(dir, key.replace(/\//g, "_"));
    const v = versionId ?? readdirSync(d).sort().at(-1)!;
    if (!existsSync(join(d, v))) throw new Error("NoSuchKey");
    return { bytes: readFileSync(join(d, v)), versionId: v, contentType: "image/png" };
  },
};

async function main() {
  if (process.argv[2] === "age") {
    const admin = new pg.Client({ connectionString: process.env.OGEVIA_LOCAL_ADMIN_URL });
    await admin.connect();
    await admin.query("set session_replication_role = replica");
    // Simulates time passing: every visit of that caregiver moves back together,
    // so earlier visits stay earlier (no artificial overlaps).
    await admin.query(
      `update ogevia.service_visits set time_in = time_in - make_interval(mins => $2),
              time_out = time_out - make_interval(mins => $2)
       where caregiver_user_id = (select caregiver_user_id from ogevia.service_visits where id = $1)`,
      [process.argv[3], Number(process.argv[4])],
    );
    await admin.end();
    return;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const handler = createHandler({
    config: {
      issuer: `https://cognito-idp.us-west-2.amazonaws.com/${process.env.OGEVIA_LOCAL_POOL}`,
      appClientIds: [process.env.OGEVIA_LOCAL_CLIENT ?? ""],
      dbSetRole: "ogevia_app",
    },
    db: { connect: () => pool.connect() },
    evidence: fileStore,
    log: () => {},
  });
  const event = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(await handler(event))}\n`);
  await pool.end();
}
void main();
