import type { ConnectionSource } from "./db";

/**
 * The scheduled caregiver-compliance run (0053). An EventBridge rule invokes the API Lambda with { "ogevia-task": "compliance-sweep" }.
 * It is not a request from a person: no Cognito claims, no tenant input. It asks the database for the agencies whose enforcement is
 * active and re-evaluates each one in its own short transaction, so the CPR/TB 14-day period is applied the moment it ends even if
 * nobody opens a caregiver profile. The decisions are made in PostgreSQL (ogevia_api.system_compliance_*); this only calls them.
 *
 * Logging policy (same as the API): counts and error codes only. Never an agency id, caregiver, name or message from the database.
 */
export const COMPLIANCE_SWEEP_TASK = "compliance-sweep";

export function isComplianceSweepEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as Record<string, unknown>)["ogevia-task"] === COMPLIANCE_SWEEP_TASK
    && !("routeKey" in event) && !("requestContext" in event);
}

export interface SweepResult {
  readonly organizations: number;
  readonly evaluated: number;
  readonly holdsOpened: number;
  readonly holdsReleased: number;
  readonly failedOrganizations: number;
}

export interface SweepDeps {
  readonly db: ConnectionSource;
  readonly dbSetRole?: string | undefined;
  readonly log?: (record: Record<string, unknown>) => void;
}

const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export async function runComplianceSweep(deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log ?? ((record) => console.log(JSON.stringify(record)));
  if (deps.dbSetRole !== undefined && !SAFE_ROLE.test(deps.dbSetRole)) throw new Error("The database role is malformed.");
  // One short transaction as the application role, no signed-in person.
  const inTx = async <T>(work: (query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> => {
    const client = await deps.db.connect();
    let broken = false;
    try {
      await client.query("begin");
      try {
        if (deps.dbSetRole) await client.query(`set local role ${deps.dbSetRole}`);
        const result = await work((sql, params) => client.query(sql, params));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } catch (error) {
      broken = !(error as { code?: unknown })?.code; // a connection-level failure poisons the client
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  };

  const orgs = await inTx(async (query) => (await query("select ogevia_api.system_compliance_orgs() as id")).rows.map((r) => r.id as string));
  let evaluated = 0;
  let opened = 0;
  let released = 0;
  let failed = 0;
  for (const org of orgs) {
    try {
      const r = await inTx(async (query) => (await query("select ogevia_api.system_compliance_sweep_org($1) as r", [org])).rows[0]?.r as Record<string, number>);
      evaluated += Number(r?.evaluated ?? 0);
      opened += Number(r?.holdsOpened ?? 0);
      released += Number(r?.holdsReleased ?? 0);
    } catch (error) {
      failed += 1;
      const sqlState = (error as { code?: unknown })?.code;
      log({ level: "error", task: COMPLIANCE_SWEEP_TASK, status: "organization_failed", ...(typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState) ? { sqlState } : {}) });
    }
  }
  const result: SweepResult = { organizations: orgs.length, evaluated, holdsOpened: opened, holdsReleased: released, failedOrganizations: failed };
  log({ level: failed > 0 ? "error" : "info", task: COMPLIANCE_SWEEP_TASK, ...result });
  // A failed agency must not look like success: the run is reported as failed after every other agency was still processed.
  if (failed > 0) throw new Error(`The compliance run failed for ${failed} of ${orgs.length} agencies.`);
  return result;
}
