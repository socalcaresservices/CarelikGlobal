// Deployment refuses altered files: keep the operator's executable pins consistent with the reviewed bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../docs/releases/2026-11-10-ux-redesign-test/toolchain/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");
const hash = (file: string) => createHash("sha256").update(readFileSync(new URL(file, root))).digest("hex");
describe("UX TEST release pins", () => {
  it("the DB operator accepts the actual verification SQL bytes", () => {
    expect(/VSQL_SHA=([0-9a-f]{64})/.exec(read("OPERATOR_TEST_DB.sh"))?.[1]).toBe(hash("VERIFY_0090_0094.sql"));
  });
  it("the published toolchain checksums match each prepared file", () => {
    const pins = read("PINS.md");
    for (const file of ["OPERATOR_TEST_DB.sh", "OPERATOR_TEST_DEPLOY.sh", "diff_gate_ux.py", "VERIFY_0090_0094.sql"]) {
      const line = pins.split("\n").find((l) => l.startsWith(`| \`${file}\` sha256 |`));
      expect(line, file).toContain(hash(file));
    }
  });
});
