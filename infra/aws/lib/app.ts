import { Tags, type App, type Stack } from "aws-cdk-lib";
import type { OgeviaEnvironmentConfig } from "./config.js";
import { EvidenceStorageStack } from "./evidence-storage-stack.js";
import { ObservabilityStack } from "./observability-stack.js";
import { ServiceVerificationApiStack } from "./service-verification-api-stack.js";

/**
 * Synthesis modes. Only `plan` exists in Phase 1: it synthesizes the complete
 * FUTURE architecture for review, tests, and template-only diff. A deploy mode
 * is added only after the owner approves a deployment (CLAUDE.md section 13).
 */
export type OgeviaMode = "plan";

export function resolveMode(value: unknown): OgeviaMode {
  if (value === "plan") return "plan";
  throw new Error(
    `Missing or unknown mode "${String(value)}". Phase 1 supports only -c mode=plan (synth/test/diff; never deploy).`,
  );
}

export interface PlannedStack {
  readonly stack: Stack;
  /** CLAUDE.md phase in which the stack may first be deployed. */
  readonly plannedPhase: number;
}

/**
 * Builds every stack for one environment. Shared by bin/ogevia.ts and the
 * tests so the tests assert exactly what `cdk synth` emits.
 *
 * A. EXISTING resources are referenced inside these stacks through
 *    lib/existing-foundation.ts and never appear as template resources.
 * B. Every stack below is NEW FUTURE infrastructure: planned, not deployed.
 */
export function buildOgeviaApp(
  app: App,
  config: OgeviaEnvironmentConfig,
  _mode: OgeviaMode = "plan",
): PlannedStack[] {
  const env = { account: config.account, region: config.region };
  const name = (suffix: string) => `Ogevia-${config.envName}-${suffix}`;

  const evidence = new EvidenceStorageStack(app, name("EvidenceStorage"), {
    config,
    env,
    description: `Ogevia ${config.envName} - private encrypted visit signature/evidence storage (FUTURE, Phase 5; not deployed)`,
  });
  const api = new ServiceVerificationApiStack(
    app,
    name("ServiceVerificationApi"),
    {
      config,
      env,
      evidenceBucket: evidence.signatureBucket,
      evidenceKey: evidence.dataKey,
      description: `Ogevia ${config.envName} - Service Verification API Gateway + Lambda tier (FUTURE, Phase 4; not deployed)`,
    },
  );
  const observability = new ObservabilityStack(app, name("Observability"), {
    config,
    env,
    handler: api.handler,
    api: api.api,
    description: `Ogevia ${config.envName} - operational alarms (FUTURE, Phase 4/7; not deployed)`,
  });

  const planned: PlannedStack[] = [
    { stack: evidence, plannedPhase: 5 },
    { stack: api, plannedPhase: 4 },
    { stack: observability, plannedPhase: 4 },
  ];

  Tags.of(app).add("project", "ogevia");
  Tags.of(app).add("environment", config.envName);
  Tags.of(app).add("managed-by", "cdk");
  for (const { stack, plannedPhase } of planned) {
    Tags.of(stack).add("ogevia:ownership", "cdk-future");
    Tags.of(stack).add("ogevia:planned-phase", String(plannedPhase));
    Tags.of(stack).add("ogevia:deployment-status", "not-approved");
  }
  return planned;
}
