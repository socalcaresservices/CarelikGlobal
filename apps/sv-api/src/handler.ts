import { randomUUID } from "node:crypto";
import {
  claimsFromHttpApiEvent,
  PrincipalError,
  principalFromClaims,
  withPrincipal,
  type AuthenticatedPrincipal,
} from "@carelik/auth/server";
import type { ApiConfig } from "./config";
import type { ConnectionSource } from "./db";
import { toApiError } from "./errors";
import type { EvidenceStore } from "./evidence";
import { errorBody, json, type HttpApiEvent, type HttpResult } from "./http";
import { ROUTES } from "./routes";

export interface LogRecord {
  readonly level: "info" | "warn" | "error";
  readonly requestId: string;
  readonly apiRequestId: string | null;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly sqlState?: string;
}

/**
 * Logging policy: one structured line per request with route TEMPLATE,
 * status, latency, request IDs and error codes. Never: bodies, query strings,
 * path values, headers, tokens, claims, signature bytes, names, notes, or
 * database error messages (they can echo input values).
 */
export type Logger = (record: LogRecord) => void;
export const consoleLogger: Logger = (record) => console.log(JSON.stringify(record));

export interface HandlerDeps {
  readonly config: Pick<ApiConfig, "issuer" | "appClientIds" | "dbSetRole">;
  readonly db: ConnectionSource;
  readonly evidence: EvidenceStore;
  readonly log?: Logger;
  readonly now?: () => number;
}

export function createHandler(deps: HandlerDeps) {
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? Date.now;

  return async function handler(event: HttpApiEvent): Promise<HttpResult> {
    const started = now();
    const requestId = randomUUID();
    const routeKey = typeof event?.routeKey === "string" ? event.routeKey : "unknown";
    const finish = (result: HttpResult, extra: Partial<LogRecord> = {}) => {
      log({
        level: result.statusCode >= 500 ? "error" : result.statusCode >= 400 ? "warn" : "info",
        requestId,
        apiRequestId: event?.requestContext?.requestId ?? null,
        route: ROUTES[routeKey] ? routeKey : "unmatched",
        status: result.statusCode,
        durationMs: now() - started,
        ...extra,
      });
      return result;
    };

    const route = ROUTES[routeKey];
    if (!route) return finish(json(404, errorBody("not_found", "No such endpoint."), requestId));

    // Public care-request/offer links use 256-bit opaque tokens and deliberately
    // do not require a Cognito account. Every other route still requires the
    // API Gateway JWT authorizer plus this defense-in-depth claims check.
    let principal: AuthenticatedPrincipal | null = null;
    if (!route.public) {
      try {
        principal = principalFromClaims(claimsFromHttpApiEvent(event), {
          issuer: deps.config.issuer,
          clientIds: deps.config.appClientIds,
        }, Math.floor(now() / 1000));
      } catch (error) {
        const reason = error instanceof PrincipalError ? error.reason : "missing_claims";
        return finish(json(401, errorBody("unauthenticated", "Sign in again to continue."), requestId), { errorCode: reason });
      }
    }

    try {
      const body = await route.handle({
        event,
        evidence: deps.evidence,
        tx: async (work) => {
          const client = await deps.db.connect();
          let broken = false;
          try {
            if (principal) {
              return await withPrincipal(client, principal, work, {
                requestId,
                ...(deps.config.dbSetRole ? { setRole: deps.config.dbSetRole } : {}),
              });
            }
            await client.query("begin");
            try {
              if (deps.config.dbSetRole) await client.query(`set local role ${deps.config.dbSetRole}`);
              const result = await work(client);
              await client.query("commit");
              return result;
            } catch (error) {
              await client.query("rollback");
              throw error;
            }
          } catch (error) {
            // Connection-level failures poison the client; destroy it.
            broken = !(error as { code?: unknown })?.code;
            throw error;
          } finally {
            client.release(broken ? true : undefined);
          }
        },
      });
      return finish(json(route.status ?? 200, body, requestId));
    } catch (error) {
      const apiError = toApiError(error);
      const sqlState = (error as { code?: unknown })?.code;
      return finish(json(apiError.status, errorBody(apiError.code, apiError.message), requestId), {
        errorCode: apiError.code,
        ...(typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState) ? { sqlState } : {}),
      });
    }
  };
}
