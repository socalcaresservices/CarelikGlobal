// LOCAL DEVELOPMENT HARNESS: runs the scheduled notification run once with the MOCK text sender against the LOCAL harness database, prints what the mock "sent" (counts and text only,
// synthetic). Never used by deployed code.   tsx local-harness/run-open-shift-sweep.ts
import pg from "pg";
import { runNotifySweep } from "../../../apps/sv-api/src/notify";
import { MockSmsSender } from "../../../apps/sv-api/src/sms";
import { ADMIN_URL, assertLocalDatabase, databaseUrl } from "./common.js";

assertLocalDatabase(ADMIN_URL);
const pool = new pg.Pool({ connectionString: databaseUrl() });
const sender = new MockSmsSender();
const r = await runNotifySweep({ db: pool as never, dbSetRole: "ogevia_app", sms: sender, log: () => undefined });
console.log(JSON.stringify({ result: r, mockSent: sender.sent.map((m) => ({ to: "…" + m.to.slice(-4), body: m.body })) }));
await pool.end();
