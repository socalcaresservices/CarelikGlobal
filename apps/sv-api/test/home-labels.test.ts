// 0120 helpers: label codes and tokens, sealing, signature stroke validation and the server-side PNG. Synthetic values only; no database, no network.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { validateSignaturePng } from "../src/evidence";
import { hashLabelToken, LABEL_CODE, LABEL_TOKEN, newLabelBatch, openLabelToken, renderSignaturePng, rowsToCsv, sealLabelToken, validateStrokes } from "../src/home-labels";

const KEY = "0123456789abcdef".repeat(4);
const withKey = <T>(fn: () => T): T => { const old = process.env.OGEVIA_QR_ENCRYPTION_KEY; process.env.OGEVIA_QR_ENCRYPTION_KEY = KEY; try { return fn(); } finally { if (old === undefined) delete process.env.OGEVIA_QR_ENCRYPTION_KEY; else process.env.OGEVIA_QR_ENCRYPTION_KEY = old; } };

/** A plausible signature: a loop and a tail, 40 points per stroke over about 1.2 seconds. */
function goodStrokes(width = 600, height = 200) {
  const stroke = (cx: number, t0: number): Array<[number, number, number]> => Array.from({ length: 40 }, (_, i) => [cx + 60 * Math.cos(i / 6), 100 + 40 * Math.sin(i / 4), t0 + i * 15] as [number, number, number]);
  return { width, height, strokes: [stroke(200, 0), stroke(330, 700)] };
}
const refuses = (input: unknown) => { try { validateStrokes(input); } catch (e) { expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(422); return; } throw new Error("accepted"); };

describe("label codes and tokens", () => {
  it("codes are OGL- plus 8 unambiguous characters, unique in a batch, with no client or agency data", () => withKey(() => {
    const batch = newLabelBatch("00000000-0000-4000-8000-000000000000", 500);
    expect(new Set(batch.map((b) => b.code)).size).toBe(500);
    for (const b of batch) { expect(b.code).toMatch(LABEL_CODE); expect(b.token).toMatch(LABEL_TOKEN); expect(b.hash).toBe(hashLabelToken(b.token)); expect(b.sealed).not.toContain(b.token); }
    expect(() => newLabelBatch("x", 0)).toThrow(ApiError); expect(() => newLabelBatch("x", 501)).toThrow(ApiError);
  }));
  it("a sealed link opens only for its own agency and fails closed when tampered or when the key is missing", () => withKey(() => {
    const sealed = sealLabelToken("a".repeat(64), "home-label:org-1");
    expect(openLabelToken(sealed, "home-label:org-1")).toBe("a".repeat(64));
    expect(() => openLabelToken(sealed, "home-label:org-2")).toThrow(ApiError);
    expect(() => openLabelToken(sealed.slice(0, -2) + "AA", "home-label:org-1")).toThrow(ApiError);
    const old = process.env.OGEVIA_QR_ENCRYPTION_KEY; delete process.env.OGEVIA_QR_ENCRYPTION_KEY;
    try { expect(() => sealLabelToken("a".repeat(64), "c")).toThrow(ApiError); } finally { process.env.OGEVIA_QR_ENCRYPTION_KEY = old; }
  }));
});

describe("signature strokes", () => {
  it("accepts a real-looking signature and rounds the stored values", () => { const v = validateStrokes(goodStrokes()); expect(v.strokes).toHaveLength(2); expect(v.strokes[0]).toHaveLength(40); });
  it("refuses an image, a data URL, a file name, extra fields and anything that is not stroke data", () => {
    for (const bad of [null, "data:image/png;base64,AAAA", "iVBORw0KGgo=", [], 7, { ...goodStrokes(), image: "data:image/png;base64,AAAA" }, { ...goodStrokes(), png: "x" }]) refuses(bad);
  });
  it("refuses a pad that is too small or large, too few or too many strokes, points outside the pad, backwards time and non-numbers", () => {
    refuses({ ...goodStrokes(), width: 50 }); refuses({ ...goodStrokes(), height: 9000 }); refuses({ ...goodStrokes(), strokes: [] });
    refuses({ ...goodStrokes(), strokes: Array.from({ length: 41 }, () => goodStrokes().strokes[0]) });
    const g = goodStrokes(); g.strokes[0]![3] = [9999, 10, 40]; refuses(g);
    const t = goodStrokes(); t.strokes[0]![5] = [210, 100, 1]; refuses(t);
    const n = goodStrokes() as any; n.strokes[0][2] = ["a", 1, 2]; refuses(n);
    const one = goodStrokes(); one.strokes[1] = [one.strokes[1]![0]!]; refuses(one);
  });
  it("refuses a dot, a straight tap, an instant scribble and an absurdly long signing time", () => {
    refuses({ width: 600, height: 200, strokes: [[[10, 10, 0], [11, 10, 400]]] });                      // a tap
    refuses({ width: 600, height: 200, strokes: [[[0, 100, 0], [600, 100, 100]]] });                     // instant, no height
    const fast = goodStrokes(); fast.strokes = fast.strokes.map((s) => s.map(([x, y]) => [x, y, 5] as [number, number, number])); refuses(fast);
    const slow = goodStrokes(); slow.strokes[1] = slow.strokes[1]!.map(([x, y, t]) => [x, y, t + 200_000] as [number, number, number]); refuses(slow);
  });
  it("caps the number of points", () => {
    const many = { width: 600, height: 200, strokes: Array.from({ length: 4 }, (_, s) => Array.from({ length: 1600 }, (_, i) => [(i % 500) + 20, 50 + s * 20, s * 2000 + i] as [number, number, number])) };
    refuses(many);
  });
});

describe("server-drawn signature image", () => {
  it("is a valid PNG that the existing evidence validator accepts, with ink on a white page, and is repeatable", () => {
    const png = renderSignaturePng(validateStrokes(goodStrokes()));
    const v = validateSignaturePng(png.toString("base64"));
    expect(v.bytes.length).toBeGreaterThan(200); expect(v.bytes.length).toBeLessThan(200_000);
    expect(png.readUInt32BE(16)).toBe(1200); expect(png.readUInt32BE(20)).toBe(400);
    // decode the single IDAT: every row starts with filter 0; count dark pixels
    let off = 8, idat = Buffer.alloc(0);
    while (off < png.length) { const len = png.readUInt32BE(off); const type = png.toString("latin1", off + 4, off + 8); if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(off + 8, off + 8 + len)]); off += 12 + len; }
    const raw = inflateSync(idat); const W = 1200, H = 400;
    expect(raw.length).toBe((W + 1) * H);
    let dark = 0, white = 0; for (let y = 0; y < H; y++) { expect(raw[y * (W + 1)]).toBe(0); for (let x = 0; x < W; x++) { const b = raw[y * (W + 1) + 1 + x]!; if (b < 0x40) dark++; else if (b === 0xff) white++; } }
    expect(dark).toBeGreaterThan(500); expect(white).toBeGreaterThan(W * H * 0.8);
    expect(renderSignaturePng(validateStrokes(goodStrokes())).equals(png)).toBe(true);
  });
});

describe("report CSV", () => {
  it("writes only the listed columns and neutralizes spreadsheet formulas", () => {
    const csv = rowsToCsv([{ a: "=SUM(A1)", b: new Date("2026-11-23T10:00:00Z"), secret: "never" }], [["A", "a"], ["B", "b"]]);
    expect(csv).toBe('"A","B"\r\n"\'=SUM(A1)","2026-11-23T10:00:00.000Z"');
    expect(csv).not.toContain("never");
  });
});
