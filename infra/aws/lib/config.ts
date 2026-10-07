import type { App } from "aws-cdk-lib";

/**
 * Environment configuration. Existing VPC/subnets are passed by context and
 * referenced with fromVpcAttributes (no account lookup), because the live AWS
 * inventory has not been verified yet (docs/aws/CURRENT_AWS_INVENTORY.md).
 *
 * Required context: vpcId, azs (comma list), privateSubnetIds (comma list,
 * isolated subnets for RDS and Lambda), dbAdminSecurityGroupId.
 * Optional: stage (default "dev"), alarmEmail, monthlyBudgetUsd.
 */
export interface OgeviaConfig {
  stage: string;
  region: string;
  vpcId: string;
  azs: string[];
  privateSubnetIds: string[];
  dbAdminSecurityGroupId: string;
  alarmEmail?: string;
  isProd: boolean;
}

const list = (v: unknown): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(app: App): OgeviaConfig {
  const ctx = (k: string): unknown => app.node.tryGetContext(k);
  const need = (k: string): string => {
    const v = ctx(k);
    if (!v) throw new Error(`Missing required CDK context "${k}" (use -c ${k}=...)`);
    return String(v);
  };
  const stage = String(ctx("stage") ?? "dev");
  const alarmEmail = ctx("alarmEmail");
  return {
    stage,
    region: "us-west-2",
    vpcId: need("vpcId"),
    azs: list(need("azs")),
    privateSubnetIds: list(need("privateSubnetIds")),
    dbAdminSecurityGroupId: need("dbAdminSecurityGroupId"),
    ...(alarmEmail ? { alarmEmail: String(alarmEmail) } : {}),
    isProd: stage === "prd",
  };
}
