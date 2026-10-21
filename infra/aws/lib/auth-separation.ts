import type { OgeviaEnvironmentConfig } from "./config.js";

/**
 * Which authentication identifiers two environments share. Pure data from the committed configuration; no AWS call.
 *
 * Why it exists: production (env=prd) and the pilot (env=prod) both use the one Cognito user pool and the legacy `ogevia-web`
 * client (verified live 2026-10-21; docs/aws/AUTH_SEPARATION_PHASE2_DESIGN.md). The target is one pool per environment. This
 * module lets a test (a) record today's sharing exactly, so a NEW shared identifier fails the build, and (b) flip to a strict
 * "nothing shared" rule once the separation is deployed.
 *
 * The per-environment web client is created by CDK (web-hosting-stack.ts) and has no id at synth time, so it is not compared here.
 */
export type SharedAuthKind = "userPool" | "cognitoDomain" | "legacyClient";

export interface SharedAuthFinding {
  readonly kind: SharedAuthKind;
  readonly value: string;
  readonly environments: readonly string[];
}

/**
 * An environment with a dedicated pool (production) owns its pool, its domain and its client, all created by CDK, so it contributes
 * identifiers unique to itself; the inherited shared-pool identifiers in its config are NOT used by its API.
 */
const identifiers = (c: OgeviaEnvironmentConfig): Record<SharedAuthKind, string> =>
  c.auth.dedicatedUserPool
    ? {
        userPool: `dedicated:${c.envName}`,
        cognitoDomain: `https://${c.auth.dedicatedUserPool.domainPrefix}.auth.${c.region}.amazoncognito.com`,
        legacyClient: `none:${c.envName}`,
      }
    : {
        userPool: c.existing.cognitoUserPoolId,
        cognitoDomain: c.testSlice.cognitoDomain,
        legacyClient: c.auth.appClientId,
      };

/** Every pool, domain or client identifier used by two or more of the given environments, in a stable order. */
export function findSharedAuth(configs: readonly OgeviaEnvironmentConfig[]): SharedAuthFinding[] {
  const seen = new Map<string, { kind: SharedAuthKind; value: string; environments: string[] }>();
  for (const config of configs) {
    for (const [kind, value] of Object.entries(identifiers(config)) as [SharedAuthKind, string][]) {
      const key = `${kind}|${value}`;
      const entry = seen.get(key) ?? { kind, value, environments: [] };
      entry.environments.push(config.envName);
      seen.set(key, entry);
    }
  }
  return [...seen.values()]
    .filter((e) => e.environments.length > 1)
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((e) => ({ kind: e.kind, value: e.value, environments: [...e.environments].sort() }));
}
