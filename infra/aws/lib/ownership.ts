// Ownership boundaries for the Ogevia CDK app. Tests enforce these lists
// against every synthesized template.

/**
 * C. DEFERRED RESOURCES - CloudFormation types no Phase 1 stack may contain.
 * Each needs a documented requirement and separate owner approval
 * (CLAUDE.md sections 11 and 13) before it can appear in a template.
 */
export const DEFERRED_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  "AWS::EC2::NatGateway": "NAT decision = DEFER (fixed hourly cost; no approved need)",
  "AWS::EC2::EIP": "Only needed for NAT/public hosts; deferred",
  "AWS::EC2::VPC": "The existing Ogevia VPC is referenced, never recreated",
  "AWS::EC2::Subnet": "Existing subnets are referenced, never recreated",
  "AWS::EC2::RouteTable": "Existing route tables are referenced",
  "AWS::EC2::Route": "Existing route tables are referenced",
  "AWS::EC2::InternetGateway": "Existing IGW is kept",
  "AWS::EC2::VPCGatewayAttachment": "Existing IGW is kept",
  "AWS::EC2::VPCEndpoint": "Existing SSM endpoints are kept; new endpoints have fixed cost",
  "AWS::EC2::SecurityGroup": "Production SGs are owned by ogevia-prod-data-layer",
  "AWS::EC2::SecurityGroupIngress": "Never add rules to CloudFormation-owned SGs from CDK",
  "AWS::EC2::SecurityGroupEgress": "Never add rules to CloudFormation-owned SGs from CDK",
  "AWS::EC2::Instance": "No always-on application servers",
  "AWS::RDS::DBInstance": "ogevia-prod-postgres is CloudFormation-owned; ogevia-postgres is unmanaged",
  "AWS::RDS::DBCluster": "Aurora is not approved",
  "AWS::RDS::DBSubnetGroup": "Owned by ogevia-prod-data-layer",
  "AWS::RDS::DBProxy": "Not justified yet",
  "AWS::ECS::Cluster": "Not approved",
  "AWS::ECS::Service": "Not approved",
  "AWS::EKS::Cluster": "Not approved",
  "AWS::OpenSearchService::Domain": "Not approved",
  "AWS::ElastiCache::CacheCluster": "Not approved",
  "AWS::ElastiCache::ReplicationGroup": "Not approved",
  "AWS::Cognito::UserPool": "The existing Cognito pool is referenced (Phase 3 decides its future)",
  "AWS::SecretsManager::Secret": "Existing secrets are referenced",
  "AWS::Budgets::Budget": "Budget changes are not approved",
  "AWS::WAFv2::WebACL": "Deferred until the exposure model justifies it",
};

/**
 * B. NEW FUTURE INFRASTRUCTURE - the only CloudFormation types a Phase 1
 * template may contain. Synthesized only; deploying any of them is a YELLOW
 * action requiring explicit approval.
 */
export const ALLOWED_PHASE1_RESOURCE_TYPES: readonly string[] = [
  "AWS::KMS::Key",
  "AWS::KMS::Alias",
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::CDK::Metadata",
];
