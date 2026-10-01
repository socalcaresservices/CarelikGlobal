import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { OgeviaEnvironmentConfig } from "./config.js";
import { SIGNATURE_OBJECT_KEY_PATTERN, signatureBucketName } from "./evidence-storage-stack.js";
import { ExistingFoundation } from "./existing-foundation.js";

export interface NetworkEgressStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
}

/**
 * Decision D-P1-1 (Phase 4 prerequisite), recommended option:
 *
 *   Lambda (private subnets, no NAT)
 *     -> Secrets Manager: INTERFACE endpoint, private DNS, in
 *        config.egress.secretsEndpointAzCount AZ(s)        FIXED ~$7.30/AZ/month
 *     -> S3 (evidence bucket only): GATEWAY endpoint on the two private
 *        route tables, policy scoped to the evidence objects   FREE
 *
 * NAT stays DEFERRED. The endpoint has its OWN security group admitting 443
 * only from the existing Lambda AppSecurityGroup; no rule is added to any
 * CloudFormation-owned group. The gateway endpoint adds an S3 prefix-list
 * route to the existing private route tables (an AWS-managed route entry;
 * no AWS::EC2::Route resource exists in the template).
 *
 * NOT DEPLOYED. Part of the single consolidated deployment approval.
 */
export class NetworkEgressStack extends Stack {
  public readonly secretsManagerEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly s3GatewayEndpoint: ec2.GatewayVpcEndpoint;
  public readonly endpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkEgressStackProps) {
    super(scope, id, { ...props, terminationProtection: props.config.terminationProtection });
    const { config } = props;
    const existing = new ExistingFoundation(this, "Existing", config.existing);
    const privateSubnets = existing.vpc.privateSubnets;
    const azCount = config.egress.secretsEndpointAzCount;
    if (azCount < 1 || azCount > privateSubnets.length) {
      throw new Error(`egress.secretsEndpointAzCount must be 1..${privateSubnets.length}`);
    }

    this.endpointSecurityGroup = new ec2.SecurityGroup(this, "SecretsEndpointSecurityGroup", {
      vpc: existing.vpc,
      description: "Ogevia Secrets Manager endpoint: HTTPS from the SV Lambda AppSecurityGroup only",
      allowAllOutbound: false,
    });
    this.endpointSecurityGroup.addIngressRule(
      existing.prodAppSecurityGroup,
      ec2.Port.tcp(443),
      "HTTPS from the Service Verification Lambda (AppSecurityGroup)",
    );

    this.secretsManagerEndpoint = new ec2.InterfaceVpcEndpoint(this, "SecretsManagerEndpoint", {
      vpc: existing.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: { subnets: privateSubnets.slice(0, azCount) },
      securityGroups: [this.endpointSecurityGroup],
      open: false,
    });
    // Only the application DB secret may be read through this endpoint.
    this.secretsManagerEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ["secretsmanager:GetSecretValue"],
        resources: [config.existing.appDatabaseSecretArn],
        conditions: { StringEquals: { "aws:PrincipalAccount": config.account } },
      }),
    );

    this.s3GatewayEndpoint = new ec2.GatewayVpcEndpoint(this, "S3GatewayEndpoint", {
      vpc: existing.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnets: privateSubnets }],
    });
    this.s3GatewayEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: [`arn:aws:s3:::${signatureBucketName(config)}/${SIGNATURE_OBJECT_KEY_PATTERN}`],
        conditions: { StringEquals: { "aws:PrincipalAccount": config.account } },
      }),
    );
  }
}
