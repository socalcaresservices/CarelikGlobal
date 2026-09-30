// Ogevia AWS environment configuration.
//
// Only us-west-2 is approved (CLAUDE.md section 1). The account is taken from
// the CDK CLI's resolved credentials at synth time; nothing here pins an
// account ID so a synth can never silently target the wrong account.
//
// Resources that were created manually during the AWS foundation work (VPC,
// security groups, VPC endpoints, IAM role, RDS) are intentionally NOT
// referenced here yet. CLAUDE.md section 7 requires live read-only
// verification before any CDK reference or import is written - see
// docs/aws/CURRENT_AWS_INVENTORY.md for their status.

export const OGEVIA_REGION = "us-west-2";

export type OgeviaStage = "dev" | "prod";

export interface OgeviaStageConfig {
  readonly stage: OgeviaStage;
  /**
   * Stateful resources (keys, evidence buckets) are always retained. This
   * flag only controls whether CloudFormation termination protection is on.
   */
  readonly terminationProtection: boolean;
}

export const STAGES: Record<OgeviaStage, OgeviaStageConfig> = {
  dev: { stage: "dev", terminationProtection: false },
  prod: { stage: "prod", terminationProtection: true },
};

export function resolveStage(value: unknown): OgeviaStageConfig {
  if (value === undefined) return STAGES.dev;
  if (value === "dev" || value === "prod") return STAGES[value];
  throw new Error(
    `Unknown stage "${String(value)}" - expected "dev" or "prod"`,
  );
}
