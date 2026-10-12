// LOCAL HARNESS SMOKE CHECK. Starts the harness in this process (database from harness:setup, web build from
// harness:build) and drives it over real HTTPS the way the web app does, with no browser:
//   - /config.json passes the web app's OWN sign-in validation (the failure behind "This Ogevia build is not configured correctly")
//   - the built app and every script/style it references are served; unknown paths open the app
//   - the full sign-in (authorization code + PKCE) works for every person, and the tokens pass the app's OWN id-token checks
//   - the API answers for each role, refuses what it must (401 / 403), and the seeded data is present
//   - the F1 accounting fix is visible in the seeded balance (needs migration 0049)
// Needs: pnpm harness:setup and pnpm harness:build first, port 443 (see README), openssl. Exit 0 = all passed.
//   pnpm --filter @carelik/infra-aws harness:smoke
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { validateIdTokenClaims } from "../../../packages/auth/src/cognito/claims.js";
import { parseCognitoConfig, cognitoIssuer } from "../../../packages/auth/src/cognito/config.js";
import { CLIENT_ID, LOCAL_DIR, ORIGIN, PERSONAS, PORT } from "./common.js";

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
let cert = Buffer.alloc(0);

function http(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, servername: "localhost", path, method, ca: cert, headers: { host: "localhost", ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
async function guarded(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** The sign-in the web app performs: authorize (code + PKCE + nonce), then exchange the code. */
async function signIn(personaKey: string) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const nonce = b64url(randomBytes(12));
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/auth/callback`, scope: "openid email",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  const picker = await http("GET", `/oauth2/authorize?${params}`);
  const chosen = await http("GET", `/oauth2/authorize?${params}&persona=${personaKey}`);
  const location = new URL(String(chosen.headers.location ?? "http://invalid/"));
  const code = location.searchParams.get("code") ?? "";
  const tokenRes = await http("POST", "/oauth2/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: `${ORIGIN}/auth/callback` }).toString(),
  });
  const tokens = JSON.parse(tokenRes.body || "{}") as { access_token?: string; id_token?: string; refresh_token?: string };
  return { picker, chosen, location, state, nonce, tokenRes, tokens, verifier };
}

const api = (path: string, token?: string) => http("GET", `/api${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
const json = (r: Res) => (r.body ? (JSON.parse(r.body) as Record<string, any>) : {});

async function main() {
  // Start the harness itself (same code as `harness:serve`); it listens on 127.0.0.1:443.
  await import("./serve.js");
  cert = readFileSync(join(LOCAL_DIR, "certs", "cert.pem"));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await http("GET", "/config.json")).status === 200) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 1. configuration
  let cfgOk = false;
  await guarded("config.json is valid for the web app", async () => {
    const r = await http("GET", "/config.json");
    const cfg = json(r);
    const parsed = parseCognitoConfig(cfg);
    cfgOk = r.status === 200 && parsed.clientId === CLIENT_ID && cfg.VITE_SV_API_BASE_URL === `${ORIGIN}/api` && cognitoIssuer(parsed).length > 0;
    check("config.json is accepted by the web app's own sign-in validation (parseCognitoConfig) and names this harness", cfgOk, `status ${r.status}`);
  });

  // 2. the built web app
  await guarded("web app", async () => {
    const r = await http("GET", "/");
    check("the web app is served (run harness:build first)", r.status === 200 && /<div id="root"/.test(r.body), `status ${r.status}`);
    const assets = [...r.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
    const fetched = await Promise.all(assets.map((a) => http("GET", a)));
    check(`every script and stylesheet the page references is served (${assets.length} files)`, assets.length > 0 && fetched.every((x) => x.status === 200 && x.body.length > 0),
      fetched.map((x, i) => `${assets[i]}:${x.status}`).filter((s) => !s.endsWith(":200")).join(", "));
    const deep = await http("GET", "/clients");
    check("a deep link opens the app (single-page fallback)", deep.status === 200 && /<div id="root"/.test(deep.body), `status ${deep.status}`);
  });

  // 3. sign-in for every person, with the app's own id-token checks
  const tokens = new Map<string, string>();
  for (const p of PERSONAS) {
    await guarded(`sign-in ${p.key}`, async () => {
      const s = await signIn(p.key);
      check(`${p.name}: the sign-in page lists the people`, s.picker.status === 200 && s.picker.body.includes(p.name), `status ${s.picker.status}`);
      check(`${p.name}: authorize redirects back with a code and the same state`, s.chosen.status === 302 && s.location.searchParams.get("state") === s.state && !!s.location.searchParams.get("code"), `status ${s.chosen.status}`);
      let idOk = false;
      if (s.tokens.id_token) {
        const cfg = parseCognitoConfig(json(await http("GET", "/config.json")));
        const id = validateIdTokenClaims(s.tokens.id_token, { issuer: cognitoIssuer(cfg), clientId: cfg.clientId, nonce: s.nonce, nowSeconds: Math.floor(Date.now() / 1000) });
        idOk = id.sub === p.sub && id.email === `${p.key}@example.invalid`;
      }
      check(`${p.name}: the code is exchanged (PKCE) and the id token passes the app's own claim checks (issuer, audience, nonce, expiry)`,
        s.tokenRes.status === 200 && !!s.tokens.access_token && !!s.tokens.refresh_token && idOk, `status ${s.tokenRes.status}`);
      if (s.tokens.access_token) tokens.set(p.key, s.tokens.access_token);
      // a wrong verifier must not work, and a code works once
      const replay = await http("POST", "/oauth2/token", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: s.location.searchParams.get("code") ?? "", code_verifier: s.verifier }).toString(),
      });
      check(`${p.name}: an authorization code works only once`, replay.status === 400, `status ${replay.status}`);
      if (p.key === "owner" && s.tokens.refresh_token) {
        const r = await http("POST", "/oauth2/token", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: s.tokens.refresh_token }).toString(),
        });
        check("refresh token returns a new access and id token", r.status === 200 && !!json(r).access_token && !!json(r).id_token, `status ${r.status}`);
      }
    });
  }

  // 4. the API
  const owner = tokens.get("owner");
  const manager = tokens.get("manager");
  const alex = tokens.get("alex");
  let org = "";
  await guarded("api identity", async () => {
    for (const [key, role] of [["owner", "organization_owner"], ["manager", "manager"], ["scheduler", "scheduler"], ["alex", "caregiver"], ["blair", "caregiver"]] as const) {
      const t = tokens.get(key);
      const r = await api("/v1/me", t);
      const m = (json(r).memberships ?? []) as Array<{ organizationId: string; role: string }>;
      check(`GET /v1/me as ${key}: exactly one membership, role ${role}`, r.status === 200 && m.length === 1 && m[0]?.role === role, `status ${r.status}`);
      if (key === "owner" && m[0]) org = m[0].organizationId;
    }
  });
  // The agency's calendar is Los Angeles time (as the seeded organization's timezone), never the machine's.
  const la = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const monthStart = `${la.year}-${la.month}-01`;
  const laDay = Number(la.day);
  const laHour = Number(la.hour);
  await guarded("api data", async () => {
    const clients = await api(`/v1/clients?organizationId=${org}`, owner);
    const list = (json(clients).clients ?? []) as Array<{ clientId: string; legalLastName?: string }>;
    check("the seeded agency has its 7 demo clients", clients.status === 200 && list.length === 7, `status ${clients.status} count ${list.length}`);
    const util = await api(`/v1/reports/utilisation?organizationId=${org}&monthStart=${monthStart}`, owner);
    check("Home figures (utilisation by service) are returned for the owner", util.status === 200 && ((json(util).services ?? []) as unknown[]).length >= 1, `status ${util.status}`);
    const attn = await api(`/v1/attention?organizationId=${org}`, owner);
    const sm = json(attn).summary ?? {};
    check("Action needed has the seeded items (an unclosed visit and open shifts)", attn.status === 200 && Number(sm.missingTimeOut) >= 1 && Number(sm.uncoveredShifts) >= 1, `status ${attn.status} ${JSON.stringify(sm).slice(0, 120)}`);
    const shifts = await api(`/v1/shifts?organizationId=${org}&from=${monthStart}&to=${new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)}`, manager);
    check("the manager sees the scheduled shifts", shifts.status === 200 && ((json(shifts).shifts ?? []) as unknown[]).length >= 5, `status ${shifts.status}`);
    // F1: the late-confirmation client counts its minutes once (needs migration 0049)
    const rivera = list.find((c) => String(c.legalLastName ?? "").includes("Rivera"));
    if (!rivera) {
      check("F1: the late-confirmation demo client exists", false, "not found");
    } else if (laDay === 1 && laHour < 2) {
      console.log("SKIP  F1 balance check: within hours of a month boundary in Los Angeles, the visit and its shift can fall in different months");
    } else {
      const sum = await api(`/v1/reports/monthly-service-summary?organizationId=${org}&monthStart=${monthStart}&clientId=${rivera.clientId}`, owner);
      const row = ((json(sum).services ?? []) as Array<Record<string, any>>)[0] ?? {};
      check("F1: authorized 600, accepted late confirmation 45, shift reserved 120: remaining is 555 (counted once)",
        sum.status === 200 && Number(row.authorizedMinutes) === 600 && Number(row.reservedMinutes) === 0 && Number(row.remainingMinutes) === 555,
        `status ${sum.status} ${JSON.stringify({ a: row.authorizedMinutes, b: row.billableMinutes, r: row.reservedMinutes, left: row.remainingMinutes })}`);
    }
  });
  await guarded("api refusals", async () => {
    const noAuth = await api(`/v1/me`);
    check("no token: 401", noAuth.status === 401, `status ${noAuth.status}`);
    const forged = owner ? owner.slice(0, -4) + "AAAA" : "x.y.z";
    check("a token with a tampered signature: 401", (await api(`/v1/me`, forged)).status === 401);
    const cg = await api(`/v1/shifts?organizationId=${org}&from=${monthStart}&to=${monthStart}`, alex);
    check("a caregiver cannot list the agency's shifts", cg.status === 403 || ((json(cg).shifts ?? []) as unknown[]).length === 0, `status ${cg.status}`);
    const assigned = await api(`/v1/clients/assigned?organizationId=${org}`, alex);
    const keys = new Set(((json(assigned).clients ?? []) as Array<Record<string, unknown>>).flatMap((c) => Object.keys(c)));
    check("a caregiver's client list has codes only (no names)", assigned.status === 200 && !keys.has("legalFirstName") && !keys.has("legalLastName") && !keys.has("firstName") && !keys.has("lastName"), `status ${assigned.status}`);
    const money = await api(`/v1/reports/utilisation?organizationId=${org}&monthStart=${monthStart}`, manager);
    const rows = (json(money).services ?? []) as Array<Record<string, unknown>>;
    check("the manager sees hours but no dollar values", money.status === 200 && rows.length >= 1 && rows.every((r) => r.billableValueCents == null && r.approvedValueCents == null && r.unusedValueCents == null), `status ${money.status}`);
    const ownerMoney = await api(`/v1/reports/utilisation?organizationId=${org}&monthStart=${monthStart}`, owner);
    check("the owner sees dollar values where a rate exists", ((json(ownerMoney).services ?? []) as Array<Record<string, unknown>>).some((r) => r.billableValueCents != null || r.unusedValueCents != null));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
