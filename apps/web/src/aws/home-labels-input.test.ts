import { describe, expect, it } from "vitest";
import { classifyLabelInput, LABEL_ID_EXAMPLE } from "./home-labels-data";

describe("sticker ID or link field", () => {
  it("accepts a printed sticker ID in any letter case and normalises it", () => {
    expect(classifyLabelInput(LABEL_ID_EXAMPLE)).toEqual({ kind: "code", code: LABEL_ID_EXAMPLE });
    expect(classifyLabelInput("  ogl-7k3m9xq2 ")).toEqual({ kind: "code", code: "OGL-7K3M9XQ2" });
  });
  it("accepts the sticker's whole link (what the tag and QR code hold)", () => {
    expect(classifyLabelInput("https://demo.example.org/l#" + "a1".repeat(32)).kind).toBe("link");
  });
  it("explains OGL-1111111: 7 characters and the digit 1 is never used", () => {
    const r = classifyLabelInput("OGL-1111111");
    expect(r.kind).toBe("invalid");
    expect((r as { message: string }).message).toMatch(/never contains "1"/);
  });
  it("explains a wrong length with the count and an example", () => {
    const r = classifyLabelInput("OGL-ABCDEFG");
    expect(r.kind).toBe("invalid");
    expect((r as { message: string }).message).toMatch(/exactly 8 characters \(you typed 7\)/);
    expect((r as { message: string }).message).toContain(LABEL_ID_EXAMPLE);
  });
  it("explains an incomplete link and an NFC chip serial number", () => {
    expect((classifyLabelInput("https://demo.example.org/l#abc") as { message: string }).message).toMatch(/incomplete/);
    expect((classifyLabelInput("04:A2:2C:5B:91:6E:80") as { message: string }).message).toMatch(/serial number/);
    expect((classifyLabelInput("hello") as { message: string }).message).toMatch(/Not recognised/);
  });
  it("an empty field says nothing", () => { expect(classifyLabelInput("  ")).toEqual({ kind: "empty" }); });
});
