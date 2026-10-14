// LOCAL DEVELOPMENT HARNESS: one HTTPS origin, https://localhost, that serves
//   /            the real AWS web build (run harness:build first)
//   /config.json the sign-in settings, as a real deployment does
//   /oauth2/*    a STAND-IN sign-in service: pick a synthetic person, no password
//   /api/*       the REAL Ogevia API handler (apps/sv-api) on the local database from harness:setup
// Synthetic data only. The stand-in tokens are signed with a key that exists only in this process, are accepted
// only by this harness, and the server listens on 127.0.0.1 only. NEVER expose it to a network.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { extname, join, normalize } from "node:path";
import pg from "pg";
import { createHandler } from "../../../apps/sv-api/src/handler.js";
import type { HttpApiEvent } from "../../../apps/sv-api/src/http.js";
import { MemoryEvidenceStore } from "../../../apps/sv-api/src/evidence.js";
import { MemoryIdentityAdmin } from "../../../apps/sv-api/src/identity.js";
import { ROUTES } from "../../../apps/sv-api/src/routes.js";
import { CLIENT_ID, DIST_DIR, ISSUER, LOCAL_DIR, ORIGIN, PERSONAS, POOL_ID, PORT, REGION, assertLocalDatabase, databaseUrl } from "./common.js";

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

// ---- certificate (self-signed, created once under .local/certs) -----------------------------------------------
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = join(LOCAL_DIR, "certs");
  const keyPath = process.env.HARNESS_KEY ?? join(dir, "key.pem");
  const certPath = process.env.HARNESS_CERT ?? join(dir, "cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "365",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    } catch {
      throw new Error("Could not create a certificate: openssl was not found. Install openssl, or create a trusted certificate for localhost with mkcert and set HARNESS_CERT and HARNESS_KEY.");
    }
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ---- stand-in sign-in service ---------------------------------------------------------------------------------
const signingKey = randomBytes(32);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const mac = (data: string) => createHmac("sha256", signingKey).update(data).digest("base64url");
const jwt = (claims: Record<string, unknown>) => {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${body}.${mac(body)}`;
};
function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2] ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const codes = new Map<string, { sub: string; nonce: string; challenge: string; exp: number }>();
const refreshTokens = new Map<string, string>();
const personaBySub = (sub: string) => PERSONAS.find((p) => p.sub === sub);

function tokensFor(sub: string, nonce: string | null) {
  const p = personaBySub(sub);
  if (!p) throw new Error("unknown person");
  const now = Math.floor(Date.now() / 1000);
  const email = `${p.key}@example.invalid`;
  const refresh = randomBytes(24).toString("base64url");
  refreshTokens.set(refresh, sub);
  return {
    access_token: jwt({ sub, iss: ISSUER, client_id: CLIENT_ID, token_use: "access", scope: "openid email", iat: now, exp: now + 3600, username: p.key }),
    id_token: jwt({ sub, email, email_verified: true, iss: ISSUER, aud: CLIENT_ID, token_use: "id", iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) }),
    refresh_token: refresh,
    expires_in: 3600,
    token_type: "Bearer",
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function pickerPage(params: URLSearchParams): string {
  const links = PERSONAS.map((p) => {
    const next = new URLSearchParams(params);
    next.set("persona", p.key);
    return `<a class="p" href="/oauth2/authorize?${esc(next.toString())}"><b>${esc(p.name)}</b><span>${esc(p.blurb)}</span></a>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local sign-in</title>
<style>body{font:15px/1.4 system-ui,sans-serif;background:#f3f6f7;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #dfe6ea;border-radius:12px;padding:24px;max-width:460px;width:92%}
h1{font-size:18px;margin:0 0 4px}p{color:#5a6b78;margin:0 0 14px;font-size:13px}.p{display:block;border:1px solid #dfe6ea;border-radius:10px;padding:10px 12px;margin:8px 0;color:inherit;text-decoration:none}.p:hover,.p:focus{border-color:#0f6b5b;background:#e3f3ef}.p span{display:block;color:#5a6b78;font-size:12px}
.w{background:#fff1d6;color:#7a4500;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:12px}</style>
<main><h1>Ogevia local harness</h1><div class="w">Stand-in sign-in for local development. No password. Synthetic people and data only.</div><p>Sign in as:</p>${links}</main>`;
}

// ---- API bridge ------------------------------------------------------------------------------------------------
assertLocalDatabase(databaseUrl());
const pool = new pg.Pool({ connectionString: databaseUrl(), max: 8 });
const evidence = new MemoryEvidenceStore();
const identity = new MemoryIdentityAdmin();
const handler = createHandler({
  config: { issuer: ISSUER, appClientIds: [CLIENT_ID], dbSetRole: "ogevia_app" },
  db: { connect: () => pool.connect() },
  evidence,
  identity,
});
const matchers = Object.keys(ROUTES).map((key) => {
  const [method = "", template = ""] = key.split(" ");
  const names: string[] = [];
  const re = new RegExp("^" + template.replace(/\{(\w+)\}/g, (_, name: string) => (names.push(name), "([^/]+)")) + "$");
  return { key, method, names, re };
  // Like API Gateway, prefer the most literal route: /v1/clients/assigned before /v1/clients/{clientId}.
}).sort((a, b) => a.names.length - b.names.length);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 12 * 1024 * 1024) throw new Error("request too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method ?? "GET";
  const m = matchers.find((r) => r.method === method && r.re.test(path));
  const pathParameters: Record<string, string> = {};
  if (m) m.re.exec(path)?.slice(1).forEach((value, i) => { pathParameters[m.names[i] ?? String(i)] = decodeURIComponent(value); });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
  const bearer = headers.authorization?.replace(/^Bearer /i, "");
  const claims = bearer ? verifyJwt(bearer) : null;
  if (bearer && !claims) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unauthenticated", message: "Sign in again to continue." } }));
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const body = method === "GET" || method === "HEAD" ? null : await readBody(req);
  const event: HttpApiEvent = {
    routeKey: m ? m.key : `${method} ${path}`,
    rawPath: path,
    headers,
    ...(Object.keys(pathParameters).length ? { pathParameters } : {}),
    ...(Object.keys(query).length ? { queryStringParameters: query } : {}),
    body,
    isBase64Encoded: false,
    requestContext: {
      requestId: randomUUID(),
      ...(claims ? { authorizer: { jwt: { claims: Object.fromEntries(Object.entries(claims).map(([k, v]) => [k, String(v)])) } } } : {}),
    },
  };
  const result = await handler(event);
  res.writeHead(result.statusCode, result.headers).end(result.body);
}

// ---- static files ------------------------------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json",
};
function sendFile(res: ServerResponse, file: string) {
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
}
function serveStatic(res: ServerResponse, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = join(DIST_DIR, rel);
  if (!file.startsWith(DIST_DIR)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isFile()) return sendFile(res, file);
  const index = join(DIST_DIR, "index.html");
  if (!existsSync(index)) {
    return void res.writeHead(503, { "content-type": "text/plain" }).end("The web app is not built yet. Run: pnpm --filter @carelik/infra-aws harness:build");
  }
  sendFile(res, index); // single-page app: unknown paths open the app
}

// ---- server ------------------------------------------------------------------------------------------------------
const server = createServer(certificate(), async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", ORIGIN);
    const p = url.pathname;
    if (p === "/config.json") {
      return void res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({
        VITE_COGNITO_REGION: REGION, VITE_COGNITO_USER_POOL_ID: POOL_ID, VITE_COGNITO_CLIENT_ID: CLIENT_ID, VITE_COGNITO_DOMAIN: ORIGIN,
        VITE_COGNITO_REDIRECT_URI: `${ORIGIN}/auth/callback`, VITE_COGNITO_LOGOUT_URI: `${ORIGIN}/`, VITE_COGNITO_REFRESH_PERSISTENCE: "session",
        VITE_SV_API_BASE_URL: `${ORIGIN}/api`, VITE_APP_ENV: "development",
      }));
    }
    if (p === "/oauth2/authorize" && req.method === "GET") {
      const q = url.searchParams;
      if (q.get("client_id") !== CLIENT_ID || q.get("redirect_uri") !== `${ORIGIN}/auth/callback` || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
        return void res.writeHead(400, { "content-type": "text/plain" }).end("Invalid sign-in request.");
      }
      const chosen = PERSONAS.find((x) => x.key === q.get("persona"));
      if (!chosen) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pickerPage(q));
      const code = randomBytes(18).toString("base64url");
      codes.set(code, { sub: chosen.sub, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", exp: Date.now() + 60_000 });
      const back = new URL(`${ORIGIN}/auth/callback`);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      return void res.writeHead(302, { location: back.toString() }).end();
    }
    if (p === "/oauth2/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const send = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!entry || entry.exp < Date.now() || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return send(400, { error: "invalid_grant" });
        return send(200, tokensFor(entry.sub, entry.nonce || null));
      }
      if (form.get("grant_type") === "refresh_token") {
        const sub = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!sub) return send(400, { error: "invalid_grant" });
        const fresh = tokensFor(sub, null);
        return send(200, { ...fresh, refresh_token: undefined });
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (p === "/logout") {
      return void res.writeHead(302, { location: `${ORIGIN}/` }).end();
    }
    if (p === "/forgotPassword") {
      return void res.writeHead(200, { "content-type": "text/plain" }).end("Password reset is not available in the local harness. There are no passwords here.");
    }
    if (p.startsWith("/api/")) return await api(req, res, url);
    return serveStatic(res, p);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Harness error. See the terminal.");
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EACCES") console.error(`\nCannot listen on port ${PORT} without permission. See local-harness/README.md ("Port 443").`);
  else if (error.code === "EADDRINUSE") console.error(`\nPort ${PORT} is already in use. Stop whatever is using it and try again.`);
  else console.error(error.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nOgevia local harness is running.\n\n  Open:  ${ORIGIN}\n\n  Your browser will warn that the certificate is not trusted (it is a local self-signed one):\n  choose Advanced, then Proceed to localhost.\n\n  Sign in as one of:`);
  for (const p of PERSONAS) console.log(`    ${p.name.padEnd(18)} ${p.blurb}`);
  console.log(`\n  Synthetic data only. Listening on 127.0.0.1. Stop with Ctrl+C. Signatures and uploaded files are kept in memory only.\n`);
});
