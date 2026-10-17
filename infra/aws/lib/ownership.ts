// Ownership boundaries for the Ogevia CDK app. Tests enforce these lists
// against every synthesized template.

/**
 * C. DEFERRED RESOURCES - CloudFormation types no Phase 1 stack may contain.
 * Each needs a documented requirement and separate owner approval
 * (CLAUDE.md sections 11 and 13) before it can appear in a template.
 */
export const DEFERRED_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  "AWS::EC2::NatGateway":
    "NAT decision = DEFER (fixed hourly cost; no approved need)",
  "AWS::EC2::EIP": "Only needed for NAT/public hosts; deferred",
  "AWS::EC2::VPC": "The existing Ogevia VPC is referenced, never recreated",
  "AWS::EC2::Subnet": "Existing subnets are referenced, never recreated",
  "AWS::EC2::RouteTable": "Existing route tables are referenced",
  "AWS::EC2::Route": "Existing route tables are referenced",
  "AWS::EC2::InternetGateway": "Existing IGW is kept",
  "AWS::EC2::VPCGatewayAttachment": "Existing IGW is kept",
  "AWS::EC2::VPCEndpoint":
    "Existing SSM endpoints are kept; new endpoints have fixed cost",
  "AWS::EC2::SecurityGroup":
    "Production SGs are owned by ogevia-prod-data-layer",
  "AWS::EC2::SecurityGroupIngress":
    "Never add rules to CloudFormation-owned SGs from CDK",
  "AWS::EC2::SecurityGroupEgress":
    "Never add rules to CloudFormation-owned SGs from CDK",
  "AWS::EC2::Instance": "No always-on application servers",
  "AWS::RDS::DBInstance":
    "ogevia-prod-postgres is CloudFormation-owned; ogevia-postgres is unmanaged",
  "AWS::RDS::DBCluster": "Aurora is not approved",
  "AWS::RDS::DBSubnetGroup": "Owned by ogevia-prod-data-layer",
  "AWS::RDS::DBProxy": "Not justified yet",
  "AWS::ECS::Cluster": "Not approved",
  "AWS::ECS::Service": "Not approved",
  "AWS::EKS::Cluster": "Not approved",
  "AWS::OpenSearchService::Domain": "Not approved",
  "AWS::ElastiCache::CacheCluster": "Not approved",
  "AWS::ElastiCache::ReplicationGroup": "Not approved",
  "AWS::Cognito::UserPool":
    "The existing Cognito pool is referenced (Phase 3 decides its future)",
  "AWS::SecretsManager::Secret": "Existing secrets are referenced",
  "AWS::Budgets::Budget": "Budget changes are not approved",
  "AWS::WAFv2::WebACL": "Deferred until the exposure model justifies it",
};

/**
 * B. NEW FUTURE INFRASTRUCTURE - the only CloudFormation types a Phase 1
 * template may contain, each with its cost class. Synthesized only; deploying
 * any of them is a YELLOW action requiring explicit approval.
 *
 * Cost classes:
 * - FIXED: bills monthly whether or not it is used.
 * - USAGE: bills per request/GB/second; ~$0 when idle.
 * - FREE: no charge for the resource itself.
 */
export type CostClass = "FIXED" | "USAGE" | "FREE";

export const ALLOWED_RESOURCE_COST_CLASS: Readonly<Record<string, CostClass>> =
  {
    "AWS::KMS::Key": "FIXED",
    "AWS::KMS::Alias": "FREE",
    "AWS::S3::Bucket": "USAGE",
    "AWS::S3::BucketPolicy": "FREE",
    "AWS::Logs::LogGroup": "USAGE",
    "AWS::IAM::Role": "FREE",
    "AWS::IAM::ManagedPolicy": "FREE",
    "AWS::Lambda::Function": "USAGE",
    "AWS::Lambda::Permission": "FREE",
    "AWS::ApiGatewayV2::Api": "USAGE",
    "AWS::ApiGatewayV2::Stage": "FREE",
    "AWS::ApiGatewayV2::Route": "FREE",
    "AWS::ApiGatewayV2::Integration": "FREE",
    "AWS::ApiGatewayV2::Authorizer": "FREE",
    "AWS::SNS::Topic": "USAGE",
    "AWS::SNS::TopicPolicy": "FREE",
    "AWS::CloudWatch::Alarm": "FIXED",
    "AWS::CDK::Metadata": "FREE",
    // 0053: the 15-minute caregiver-compliance run. EventBridge scheduled rules have no charge; the Lambda cost is far below any
    // billing threshold. Deploying it is a YELLOW action that needs the owner's approval.
    "AWS::Events::Rule": "FREE",
    // Phase 6 web hosting (static assets only; no PHI at rest in the bucket).
    "AWS::CloudFront::Distribution": "USAGE",
    "AWS::CloudFront::OriginAccessControl": "FREE",
    "AWS::CloudFront::Function": "USAGE",
    "AWS::CloudFront::ResponseHeadersPolicy": "FREE",
    // Phase 3/6: a NEW public app client in the EXISTING pool for the test
    // slice. The pool itself and the existing ogevia-web client are untouched.
    "AWS::Cognito::UserPoolClient": "FREE",
    "AWS::Cognito::ManagedLoginBranding": "FREE",
  };

/**
 * Per-stack exceptions to DEFERRED_RESOURCE_TYPES. Matched on the stack-name
 * suffix. Each exists for one documented decision and only in that stack.
 *
 * NetworkEgress (decision D-P1-1): the Lambda runs in private subnets with no
 * NAT. It needs Secrets Manager (interface endpoint, FIXED cost) and S3
 * (gateway endpoint, FREE). The endpoint gets its OWN new security group;
 * no rule is added to any CloudFormation-owned group.
 */
export const STACK_RESOURCE_EXCEPTIONS: Readonly<
  Record<string, Readonly<Record<string, { cost: CostClass; reason: string }>>>
> = {
  NetworkEgress: {
    "AWS::EC2::VPCEndpoint": {
      cost: "FIXED",
      reason: "D-P1-1: Secrets Manager interface endpoint (fixed hourly) + S3 gateway endpoint (free); NAT stays deferred",
    },
    "AWS::EC2::SecurityGroup": {
      cost: "FREE",
      reason: "New SG for the Secrets Manager endpoint ENIs only: 443 from the Lambda AppSecurityGroup",
    },
    "AWS::EC2::SecurityGroupIngress": {
      cost: "FREE",
      reason: "The 443 rule ON THE NEW endpoint SG (source: AppSecurityGroup). template-scan fails any rule whose GroupId is a pre-existing SG",
    },
  },
};

export function stackException(stack: string, type: string) {
  for (const [suffix, types] of Object.entries(STACK_RESOURCE_EXCEPTIONS)) {
    if (stack.endsWith(`-${suffix}`) && types[type]) return types[type];
  }
  return undefined;
}

export const ALLOWED_PHASE1_RESOURCE_TYPES: readonly string[] = Object.keys(
  ALLOWED_RESOURCE_COST_CLASS,
);

/** Stateful types that must carry DeletionPolicy/UpdateReplacePolicy Retain. */
export const RETAINED_RESOURCE_TYPES: readonly string[] = [
  "AWS::KMS::Key",
  "AWS::S3::Bucket",
  "AWS::Logs::LogGroup",
];

/**
 * The single statement allowed to use Resource "*": Lambda VPC ENI management,
 * which EC2 does not support at resource level.
 */
export const WILDCARD_RESOURCE_ALLOWED_ACTIONS: readonly string[] = [
  "ec2:AssignPrivateIpAddresses",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:UnassignPrivateIpAddresses",
];
