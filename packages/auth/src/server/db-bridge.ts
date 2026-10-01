import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "./principal";

/** Minimal client surface (satisfied by node-postgres PoolClient). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The ONLY way Phase 4 code may run database work for a caller:
 *
 *   BEGIN
 *   SET LOCAL ROLE ogevia_app           (when connected as an admin; omitted in prod)
 *   SELECT ogevia_api.begin_request($sub, $request_id)   -> app_users by cognito_sub
 *   <ogevia_api.* call(s)>              -> membership/role/assignment resolved in SQL
 *   COMMIT
 *
 * The verified `sub` is the only identity input. Organization, role,
 * permissions and assignments never come from the token or the browser.
 */
export async function withPrincipal<T>(
  client: Queryable,
  principal: AuthenticatedPrincipal,
  work: (client: Queryable) => Promise<T>,
  options: { requestId?: string; setRole?: string } = {},
): Promise<T> {
  const requestId = options.requestId ?? randomUUID();
  await client.query("begin");
  try {
    if (options.setRole) {
      if (!/^[a-z_][a-z0-9_]*$/.test(options.setRole)) throw new Error("invalid role name");
      await client.query(`set local role ${options.setRole}`);
    }
    await client.query("select ogevia_api.begin_request($1, $2)", [principal.sub, requestId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
