import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../../docs/releases/2026-10-18-interface-simplification");
const doc = readFileSync(resolve(DIR, "SNAPSHOT_RESTORE_ISOLATED_3159e52.md"), "utf8");
const procedure = readFileSync(resolve(DIR, "OPERATOR_PROCEDURE_3159e52.md"), "utf8");
const rehearsal = readFileSync(resolve(DIR, "snapshot-restore-local-rehearsal.sh"), "utf8");

// Executable lines only: fenced code blocks of the restore document.
const commands = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");

describe("isolated snapshot-restore document", () => {
  it("never connects to or names ogevia_prd in a command, and never uses pg_dumpall or in-place restore flags", () => {
    expect(commands).not.toMatch(/-d\s+ogevia_prd|dbname=ogevia_prd|\/ogevia_prd\b/);
    expect(commands.match(/ogevia_prd/g)?.length ?? 0).toBeLessThanOrEqual(2); // a tag value and a placeholder comment only
    expect(commands).not.toMatch(/pg_dumpall|--create|--clean|-C\b/);
    expect(commands).not.toMatch(/restore-db-instance-to-point-in-time|--db-instance-identifier ogevia-prod-postgres\b.*restore/);
  });

  it("restores only to a NEW instance with its own security group, private and encrypted", () => {
    expect(commands).toMatch(/restore-db-instance-from-db-snapshot/);
    expect(commands).toMatch(/--db-instance-identifier ogevia-recovery-\$STAMP/);
    expect(commands).toMatch(/--no-publicly-accessible/);
    expect(commands).toMatch(/--vpc-security-group-ids "\$RSG"/);
    expect(commands).not.toMatch(/sg-00530a1f4f7648e65|sg-064ffce3bcbe8eb3b/);
  });

  it("states that it is documented, not proven, and not verified on AWS", () => {
    expect(doc).toMatch(/NOT a proven recovery procedure/);
    expect(doc).toMatch(/NOT RUN, NOT VERIFIED/);
    expect(doc).toMatch(/NOT WRITTEN/);
  });

  it("uses digits-only stamps for the renamed database (PostgreSQL folds unquoted identifiers to lower case)", () => {
    expect(doc).toMatch(/ogevia_sv_test_damaged_<yyyymmddHHMM>/);
    expect(doc).not.toMatch(/damaged_\d{8}T/);
  });
});

describe("operator procedure and local rehearsal agree with it", () => {
  it("the procedure points to the document without calling snapshot recovery proven", () => {
    expect(procedure).toMatch(/SNAPSHOT_RESTORE_ISOLATED_3159e52\.md/);
    expect(procedure).toMatch(/NOT PREPARED, NOT REHEARSED ON AWS/);
    expect(procedure).toMatch(/not a proven recovery procedure/);
  });

  it("the local rehearsal never connects to a database named ogevia_prd except to count rows, and uses no AWS", () => {
    expect(rehearsal).not.toMatch(/\baws\b\s+(rds|ec2|s3)/);
    expect(rehearsal).not.toMatch(/pg_dump[^\n]*-d ogevia_prd|pg_restore[^\n]*-d ogevia_prd/);
  });
});
