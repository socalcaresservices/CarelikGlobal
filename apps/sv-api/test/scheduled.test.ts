// The scheduled compliance run (0053): event recognition, one short transaction per agency, counts-only logging, and a failed
// agency is reported as a failed run (never as success). No database: the SQL decisions are tested in the infra-aws db suite.
import { describe, expect, it } from "vitest";
import { COMPLIANCE_SWEEP_TASK, isComplianceSweepEvent, runComplianceSweep } from "../src/scheduled";
import { event } from "./fixtures";

function fakeDb(plan: { orgs: string[]; results?: Record<string, unknown>; failOrg?: string }) {
  const statements: string[] = [];
  let released: Array<true | undefined> = [];
  const db = {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql.replace(/\s+/g, " "));
        if (/system_compliance_orgs/.test(sql)) return { rows: plan.orgs.map((id) => ({ id })) };
        if (/system_compliance_sweep_org/.test(sql)) {
          const org = String(params?.[0]);
          if (org === plan.failOrg) throw Object.assign(new Error("boom with a private detail: Jane Doe 555-0100"), { code: "XX000" });
          return { rows: [{ r: plan.results?.[org] ?? { evaluated: 3, holdsOpened: 1, holdsReleased: 0 } }] };
        }
        return { rows: [] };
      },
      release: (broken?: true) => { released.push(broken); },
    }),
  };
  return { db: db as never, statements, released: () => released };
}

describe("scheduled compliance run", () => {
  it("recognises only the scheduled shape; an HTTP request can never look like it", () => {
    expect(isComplianceSweepEvent({ "ogevia-task": COMPLIANCE_SWEEP_TASK })).toBe(true);
    expect(isComplianceSweepEvent({ "ogevia-task": "something-else" })).toBe(false);
    expect(isComplianceSweepEvent(null)).toBe(false);
    expect(isComplianceSweepEvent("compliance-sweep")).toBe(false);
    // API Gateway always adds routeKey and requestContext; even a forged body field cannot remove them
    expect(isComplianceSweepEvent({ ...event("GET /v1/me", { sub: "11111111-2222-4333-8444-555555555555" }), "ogevia-task": COMPLIANCE_SWEEP_TASK })).toBe(false);
  });

  it("asks for the agencies first, then sweeps each in its own transaction as the application role", async () => {
    const f = fakeDb({ orgs: ["org-1", "org-2"] });
    const logs: Record<string, unknown>[] = [];
    const result = await runComplianceSweep({ db: f.db, dbSetRole: "ogevia_app", log: (r) => logs.push(r) });
    expect(result).toEqual({ organizations: 2, evaluated: 6, holdsOpened: 2, holdsReleased: 0, failedOrganizations: 0 });
    expect(f.statements.filter((s) => s === "begin")).toHaveLength(3);
    expect(f.statements.filter((s) => s === "commit")).toHaveLength(3);
    expect(f.statements.filter((s) => s === "set local role ogevia_app")).toHaveLength(3);
    expect(f.statements.some((s) => s === "rollback")).toBe(false);
    expect(logs).toEqual([{ level: "info", task: "compliance-sweep", ...result }]);
  });

  it("a failed agency does not stop the others, is logged without its message, and the run is reported as failed", async () => {
    const f = fakeDb({ orgs: ["org-1", "org-2", "org-3"], failOrg: "org-2" });
    const logs: Record<string, unknown>[] = [];
    await expect(runComplianceSweep({ db: f.db, dbSetRole: "ogevia_app", log: (r) => logs.push(r) })).rejects.toThrow(/failed for 1 of 3 agencies/);
    expect(f.statements.filter((s) => s === "rollback")).toHaveLength(1);
    expect(f.statements.filter((s) => /system_compliance_sweep_org/.test(s))).toHaveLength(3); // org-3 still ran
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/Jane|555|org-/);
    expect(logs.at(-1)).toMatchObject({ level: "error", failedOrganizations: 1, holdsOpened: 2 });
  });

  it("refuses a malformed database role instead of interpolating it", async () => {
    await expect(runComplianceSweep({ db: fakeDb({ orgs: [] }).db, dbSetRole: "ogevia_app; drop table x", log: () => {} })).rejects.toThrow(/malformed/);
  });

  it("with no agency enforcing yet, nothing runs", async () => {
    const f = fakeDb({ orgs: [] });
    expect(await runComplianceSweep({ db: f.db, dbSetRole: "ogevia_app", log: () => {} })).toMatchObject({ organizations: 0, evaluated: 0 });
    expect(f.statements.filter((s) => /system_compliance_sweep_org/.test(s))).toHaveLength(0);
  });
});
