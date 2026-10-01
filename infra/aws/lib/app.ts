import { Tags, type App, type Stack } from "aws-cdk-lib";
import type { OgeviaEnvironmentConfig } from "./config.js";
import { EvidenceStorageStack } from "./evidence-storage-stack.js";

/**
 * Builds every stack for one environment. Shared by bin/ogevia.ts and the
 * tests so the tests assert exactly what `cdk synth` emits.
 *
 * Existing AWS resources are referenced through lib/existing-foundation.ts by
 * stacks that need them. No Phase 1 stack consumes them yet.
 */
export function buildOgeviaApp(
  app: App,
  config: OgeviaEnvironmentConfig,
): Stack[] {
  const evidence = new EvidenceStorageStack(
    app,
    `Ogevia-${config.envName}-EvidenceStorage`,
    {
      config,
      env: { account: config.account, region: config.region },
      description: `Ogevia ${config.envName} - private encrypted visit signature/evidence storage (FUTURE/PROVISIONAL, Phase 5)`,
    },
  );

  Tags.of(app).add("project", "ogevia");
  Tags.of(app).add("environment", config.envName);
  Tags.of(app).add("managed-by", "cdk");

  return [evidence];
}
