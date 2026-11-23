// NFC / QR home labels and signature strokes (0120). Pure helpers used by the 0120 routes in routes.ts: label codes and tokens, sealing a token for reprint, stroke validation, and
// a small server-side PNG renderer. Nothing here talks to the database or to S3, and nothing here logs a token, a stroke or an image.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ApiError } from "./errors";
import { csvCell } from "./exports";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
/** Printed sticker IDs: OGL- plus 8 characters that cannot be mistaken for one another (no I, O, 0, 1). They carry no client or agency information. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LABEL_CODE = /^OGL-[A-HJ-NP-Z2-9]{8}$/;
/** The opaque link token: 256 random bits as hex. One token per label; replacing a label retires its token. */
export const LABEL_TOKEN = /^[0-9a-f]{64}$/;

export const hashLabelToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newLabelCode = () => "OGL-" + Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

function sealingKey(): Buffer {
  // The same key parameter as the existing client QR card (OGEVIA_QR_ENCRYPTION_KEY); no new secret is introduced.
  const configured = process.env.OGEVIA_QR_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(configured)) throw new ApiError(503, "unavailable", "Label printing is unavailable.");
  return Buffer.from(configured, "hex");
}
export function sealLabelToken(token: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(), iv).setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function openLabelToken(sealed: string, context: string): string {
  const payload = Buffer.from(sealed, "base64url");
  if (payload.length < 29) throw new ApiError(503, "unavailable", "This label link is unavailable.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(), payload.subarray(0, 12)).setAAD(Buffer.from(context)).setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError(503, "unavailable", "This label link is unavailable.");
  }
}
export const labelContext = (organizationId: string) => `home-label:${organizationId}`;

export interface NewLabel { code: string; token: string; hash: string; sealed: string }
/** Fresh codes and tokens for a batch. The tokens leave this function only inside `sealed` (and, for the supplier file, through the link endpoint); the database sees hashes and sealed copies. */
export function newLabelBatch(organizationId: string, count: number): NewLabel[] {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new ApiError(400, "bad_request", "Register between 1 and 500 labels at a time.");
  const seen = new Set<string>();
  const out: NewLabel[] = [];
  while (out.length < count) {
    const code = newLabelCode();
    if (seen.has(code)) continue;
    seen.add(code);
    const token = randomBytes(32).toString("hex");
    out.push({ code, token, hash: hashLabelToken(token), sealed: sealLabelToken(token, labelContext(organizationId)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signature strokes
// ---------------------------------------------------------------------------
/** A drawn signature as the pad records it: pointer positions with times. There is no image, no data URL and no file in this format. */
export interface StrokeData { width: number; height: number; strokes: Array<Array<[number, number, number]>> }

const LIMITS = { minW: 200, maxW: 1200, minH: 80, maxH: 600, maxStrokes: 40, maxPoints: 6000, minMs: 250, maxMs: 120_000, minInkPx: 60, minSpanX: 30, minSpanY: 6 };

const invalid = (why: string) => new ApiError(422, "validation_failed", `The signature could not be accepted (${why}). Please sign again.`);

export function validateStrokes(input: unknown): StrokeData {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("not stroke data");
  const o = input as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => !["width", "height", "strokes"].includes(k))) throw invalid("unexpected fields");
  const { width, height, strokes } = o as { width: unknown; height: unknown; strokes: unknown };
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < LIMITS.minW || (width as number) > LIMITS.maxW || (height as number) < LIMITS.minH || (height as number) > LIMITS.maxH) throw invalid("pad size");
  if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > LIMITS.maxStrokes) throw invalid("stroke count");
  const w = width as number, h = height as number;
  let points = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, ink = 0, t0 = Infinity, tN = -Infinity;
  const clean: StrokeData["strokes"] = [];
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2) throw invalid("stroke too short");
    const out: Array<[number, number, number]> = [];
    let lastT = -Infinity, px = NaN, py = NaN;
    for (const pt of stroke) {
      if (!Array.isArray(pt) || pt.length !== 3 || !pt.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalid("point format");
      const [x, y, t] = pt as [number, number, number];
      if (x < 0 || x > w || y < 0 || y > h) throw invalid("point outside the pad");
      if (t < 0 || t < lastT) throw invalid("time order");
      lastT = t;
      if (!Number.isNaN(px)) ink += Math.hypot(x - px, y - py);
      px = x; py = y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      t0 = Math.min(t0, t); tN = Math.max(tN, t);
      out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(t)]);
      if (++points > LIMITS.maxPoints) throw invalid("too many points");
    }
    clean.push(out);
  }
  if (tN - t0 < LIMITS.minMs || tN - t0 > LIMITS.maxMs) throw invalid("signing time");
  if (ink < LIMITS.minInkPx || maxX - minX < LIMITS.minSpanX || maxY - minY < LIMITS.minSpanY) throw invalid("too little ink");
  return { width: w, height: h, strokes: clean };
}

// ---------------------------------------------------------------------------
// PNG rendering (8-bit grayscale, white page, dark ink). The caregiver's phone never produces the image: the server draws it from the validated strokes.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function renderSignaturePng(data: StrokeData, scale = 2): Buffer {
  const W = data.width * scale, H = data.height * scale;
  const px = Buffer.alloc(W * H, 0xff);
  const radius = Math.max(1, Math.round(1.1 * scale));
  const dot = (cx: number, cy: number) => {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = 0x14;
    }
  };
  for (const stroke of data.strokes) {
    for (let i = 0; i < stroke.length; i++) {
      const [x1, y1] = stroke[i]!; const [x0, y0] = i === 0 ? [x1, y1] : stroke[i - 1]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * scale));
      for (let s = 0; s <= steps; s++) dot(Math.round((x0 + ((x1 - x0) * s) / steps) * scale), Math.round((y0 + ((y1 - y0) * s) / steps) * scale));
    }
  }
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; px.copy(raw, y * (W + 1) + 1, y * W, (y + 1) * W); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Report CSV: only the columns the server returned (no signature image, precise GPS or signing link is ever in a row)
// ---------------------------------------------------------------------------
export function rowsToCsv(rows: Array<Record<string, unknown>>, columns: Array<[header: string, key: string]>): string {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const lines = [columns.map(([h]) => csvCell(h)).join(",")];
  for (const r of rows) lines.push(columns.map(([, k]) => csvCell(iso(r[k]))).join(","));
  return lines.join("\r\n");
}
