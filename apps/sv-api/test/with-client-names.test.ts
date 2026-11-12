// withClientNames adds clientName / duplicateName beside every object that carries a clientCode or clientId. It must not damage any other value:
// a JavaScript Date is an object, and rebuilding it as a plain object turned every timestamptz column into `{}` (found by the B9 regression check).
import { describe, expect, it } from "vitest";
import { withClientNames } from "../src/routes";

const dir = { client: (id: unknown, code: unknown) => (code === "CL-1" || id === "c-1" ? { name: "Demo Vega", duplicate: false } : null) };

describe("withClientNames", () => {
  it("keeps Date values as Dates (they serialize as ISO strings, never as {})", () => {
    const at = new Date("2026-10-30T21:00:00.000Z");
    const out = withClientNames({ impacts: [{ clientCode: "CL-1", createdAt: at, shiftStartsAt: at, acknowledgedAt: null }] }, dir);
    expect(out.impacts[0]!.createdAt).toBeInstanceOf(Date);
    expect(out.impacts[0]!.createdAt).toBe(at);
    expect(JSON.parse(JSON.stringify(out))).toEqual({ impacts: [{ clientCode: "CL-1", createdAt: "2026-10-30T21:00:00.000Z", shiftStartsAt: "2026-10-30T21:00:00.000Z", acknowledgedAt: null, clientName: "Demo Vega", duplicateName: false }] });
  });

  it("keeps a Date nested deeper than the row, inside arrays and objects", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    const out = withClientNames([{ clientId: "c-1", history: [{ when: at, detail: { seen: at } }] }], dir);
    const h = (out[0] as any).history[0];
    expect(h.when).toBe(at);
    expect(h.detail.seen).toBe(at);
  });

  it("still adds names where a clientCode or clientId is present, at any depth, and only there", () => {
    const out = withClientNames({ a: { clientCode: "CL-1" }, b: { clientId: "c-1", inner: { clientCode: "CL-1" } }, c: { clientCode: "CL-unknown" }, d: { other: 1 } }, dir) as any;
    expect(out.a).toMatchObject({ clientName: "Demo Vega", duplicateName: false });
    expect(out.b).toMatchObject({ clientName: "Demo Vega" });
    expect(out.b.inner).toMatchObject({ clientName: "Demo Vega" });
    expect(out.c).not.toHaveProperty("clientName");
    expect(out.d).toEqual({ other: 1 });
  });

  it("leaves strings, numbers, booleans and null untouched and does not mutate its input", () => {
    const input = { clientCode: "CL-1", n: 3, s: "x", b: false, z: null, list: [1, "a", null] };
    const copy = JSON.parse(JSON.stringify(input));
    const out = withClientNames(input, dir) as any;
    expect(input).toEqual(copy);
    expect(out).toMatchObject({ n: 3, s: "x", b: false, z: null, list: [1, "a", null], clientName: "Demo Vega" });
  });
});
