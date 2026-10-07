// SYNTHETIC fixtures only: no real users, tokens, or PHI.
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { HttpApiEvent } from "../src/http";

export const REGION = "us-west-2";
export const POOL = "us-west-2_TESTPOOL1";
export const CLIENT = "testclient0000000000000000";
export const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
export const CONFIG = { issuer: ISSUER, appClientIds: [CLIENT], dbSetRole: "ogevia_app" };

export function claims(sub: string, overrides: Record<string, unknown> = {}) {
  // API Gateway passes JWT claims to Lambda as strings.
  return {
    sub,
    iss: ISSUER,
    client_id: CLIENT,
    token_use: "access",
    scope: "openid email",
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  };
}

export function event(
  routeKey: string,
  opts: {
    sub?: string | null;
    claims?: Record<string, unknown>;
    path?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    key?: string | null;
    headers?: Record<string, string>;
  } = {},
): HttpApiEvent {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key !== null && routeKey.startsWith("POST")) headers["idempotency-key"] = opts.key ?? randomUUID();
  return {
    routeKey,
    headers,
    ...(opts.path ? { pathParameters: opts.path } : {}),
    ...(opts.query ? { queryStringParameters: opts.query } : {}),
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    requestContext: {
      requestId: "apigw-test-request",
      ...(opts.sub === null
        ? {}
        : { authorizer: { jwt: { claims: opts.claims ?? claims(opts.sub ?? "11111111-2222-4333-8444-555555555555") } } }),
    },
  };
}

function crc32(buf: Buffer) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid grayscale PNG of the given size (a synthetic "signature"). */
export function syntheticPng(width = 40, height = 20, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (x * 7 + y * 13 + seed) & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
