# Automated drift monitoring for production: proposal

**Status: PROPOSED. Nothing is built, deployed or changed in AWS. Deploying any part of it is a YELLOW action (`CLAUDE.md` section 13) and needs the Owner's explicit approval, including the recurring cost.** Written 2026-10-27 on the Owner's instruction: "Automate ongoing drift checks. A weekly CloudShell task that depends on you remembering to run it does not meet your requirement for automatic monitoring."

Labels: VERIFIED (read from a committed file), INFERRED, NOT VERIFIED. **Every price below is an estimate from memory of AWS public pricing and is NOT VERIFIED against the current AWS price pages; it must be re-checked before approval.**

## 1. What it must do
Detect, without anyone remembering to run it, any change to a **deployment-controlled** production resource that no release explains, and tell the Owner.

**In scope** (code, configuration, infrastructure):
- CloudFormation stacks `Ogevia-prd-*` and `Ogevia-prod-NetworkEgress`: status, last-update time, template hash.
- API Lambda: code hash (`CodeSha256`), environment variable names and values that are not secrets, role, last-modified time.
- Website: the CloudFront distribution configuration hash, response-headers policy, and the served `index.html` hash and version string.
- API Gateway: route count and set, authorizer, CORS origins.
- Cognito production pool: app-client callback and logout URLs, MFA setting.
- IAM roles and policies of the stack, and security-group rules on the database (a stray open rule is the most important item).
- Deployment state of the database: ledger count and latest version, schema fingerprint (see the limit in section 5).

**Out of scope, never an alert** (expected activity): client, caregiver, shift, visit, authorization, staff and user records; invitations; log volume; scheduled snapshots; the scheduled ComplianceSweep run; normal CloudWatch metrics.

## 2. Baseline: where "expected" comes from
- The first baseline is `docs/aws/PRODUCTION_AS_FOUND_2026-10-26.md` (observed values; unknown commit mappings stay NOT VERIFIED).
- After each release the existing read-only record step (`record-deployed-prd.sh`) produces the new expected values. A small addition to that step writes the same values as one JSON object to a single private location (SSM Parameter Store, or one S3 object) that only the operator's deployment role can write and the monitor can read. **The monitor never writes the baseline**: a compromised monitor cannot hide drift.
- A release window flag, set by the operator when a release starts and cleared by the record step, pauses alerts during the window so a planned deployment is not reported as drift. If the record step reports "DEPLOYED - RECORD INCOMPLETE", the flag stays and a separate "record incomplete" reminder is sent daily.

## 3. Options considered
| Option | What it catches | Fixed cost | Verdict |
|---|---|---|---|
| A. CloudTrail events to alerts (EventBridge rule on write calls such as `UpdateStack`, `UpdateFunctionCode`, `UpdateDistribution`, `UpdateUserPoolClient`, `AuthorizeSecurityGroupIngress`, `PutRolePolicy`) | Who changed what and when, as it happens | about 0 (a CloudTrail trail `ogevia-audit-trail`, multi-region with validation, is already recorded in `docs/aws/INVENTORY_RECONCILIATION_2026-10-21.md`, VERIFIED as of that date; EventBridge rules on AWS events and SNS email are free or near-free) | **Recommended, part of v1.** Does not say whether the result matches the baseline |
| B. Scheduled sentinel Lambda comparing live state with the baseline (once a day) | Silent differences, including code hash and CORS/URLs, that a stack template alone would not show | Lambda (about 30 runs a month), a log group with finite retention, one SSM parameter or S3 object, SNS: roughly 0 to 2 USD a month | **Recommended, core of v1** |
| C. CloudFormation drift detection (`DetectStackDrift`) from the sentinel | Out-of-band edits to resources a stack manages (for example a hand-edited security group) | no charge for the API | **Recommended inside B.** Coverage of Lambda code content is not assumed; the code hash check in B covers it |
| D. AWS Config rules and recording | Continuous configuration history and rules | per configuration item and per rule evaluation: likely 5 to 15 USD a month and more as resources grow | **Not recommended now.** Recurring cost without a gap it closes that A, B and C leave open (`CLAUDE.md` section 11) |

## 4. Proposed design (v1 = A + B + C)
- One new CDK stack, `Ogevia-prd-DriftMonitor`, in the existing `infra/aws` project (no second tool or IaC system).
- **Sentinel Lambda**: runs once a day (EventBridge schedule), reads live state, reads the baseline and the release flag, compares, publishes one SNS message listing each differing item (resource, field, expected, found; never a secret value or record content) and a CloudWatch metric `DriftItems`. A daily "OK, N items checked" line is also sent for the first month so silence cannot mean "not running"; an alarm fires if the sentinel itself does not run for 36 hours.
- **Event rule (A)**: CloudTrail write events on the in-scope resources are routed to the same topic with the actor's role name and time.
- **Alert destination**: the existing `Ogevia-prd-Observability` alarm topic, which has no subscribers unless an alarm email is configured (VERIFIED in `infra/aws/lib/observability-stack.ts`). Whether an email is subscribed in production today is NOT VERIFIED. **The Owner must name the address.**
- **No VPC**: the sentinel needs no database access in v1, so no NAT Gateway or new endpoint (`CLAUDE.md` section 11: no NAT without approval).

## 5. Limits stated up front
- The database ledger and schema fingerprint need a database connection. v1 does **not** include them; they stay a pre-release step (the existing read-only ledger check in the production package). A v2 could add a VPC Lambda with a read-only database role; that adds a role, a secret and an endpoint dependency, and needs its own approval.
- The monitor can only compare what the baseline recorded. Anything never recorded (the unknown historical mappings) cannot be flagged as drift; it can only be flagged once a release records it.
- A change that leaves every compared value the same (for example an identical code upload) is invisible by design.
- The sentinel proves nothing about application behaviour; it is not a substitute for the smoke tests.

## 6. Permissions required
**Sentinel role (read-only; resource-scoped to the production stacks, function, distribution, API, pool and database security group wherever AWS allows it):**
- `cloudformation:DescribeStacks`, `GetTemplate`, `ListStackResources`, `DetectStackDrift`, `DescribeStackDriftDetectionStatus`, `DescribeStackResourceDrifts`
- `lambda:GetFunction`, `GetFunctionConfiguration`
- `cloudfront:GetDistribution`, `GetDistributionConfig`, `GetResponseHeadersPolicy`
- `apigateway:GET` on the production API
- `cognito-idp:DescribeUserPoolClient`, `DescribeUserPool` on the production pool
- `iam:GetRole`, `GetRolePolicy`, `ListRolePolicies`, `ListAttachedRolePolicies` on the stack roles
- `ec2:DescribeSecurityGroups`, `DescribeSecurityGroupRules`
- `ssm:GetParameter` (or `s3:GetObject`) on the single baseline and flag locations
- `sns:Publish` on the one alarm topic; `cloudwatch:PutMetricData` in its own namespace; `logs:CreateLogStream`, `PutLogEvents` on its own log group
- It holds **no** write, delete, secret-read or data-read permission, and cannot read the web bucket's contents or the database.

**To deploy it (the Operator, once, after approval):** `cloudformation:*` on the one new stack and the IAM, Lambda, EventBridge, SNS-policy and logs actions that CDK needs for it, using the existing CDK deployment role. The stack's IAM changes must be listed in the `cdk diff` shown to the Owner before deployment.

## 7. Cost summary (estimate, NOT VERIFIED against current pricing)
| Resource | Fixed cost? | Dev estimate | Initial production estimate | Scaling driver |
|---|---|---|---|---|
| Sentinel Lambda, daily | no | under 0.10 USD a month | under 0.10 USD a month | number of checks per run |
| Log group with finite retention | no | under 0.10 USD | under 0.50 USD | log lines per run |
| EventBridge rules (AWS events) | no | 0 | 0 | none |
| SNS email | no | 0 | 0 | number of alerts |
| Baseline in SSM or S3 | no | about 0 | about 0 | size of one JSON |
| CloudWatch alarm for "sentinel did not run" | yes (per alarm) | 0.10 USD | 0.10 to 0.30 USD | alarms |
| **Total** | | about 0.3 USD | **about 0.3 to 1.5 USD a month** | grows with resources monitored, not with customers |

Cheaper alternative considered: A only (about 0 USD). It tells you that something changed but not whether the result matches the baseline, so it is kept as part of v1 rather than as the whole answer. A weekly manual CloudShell check is rejected by the Owner's requirement.

## 8. Rollout (each step needs the Owner's approval before it runs)
1. Build the stack and sentinel in the repository with unit tests on mocked AWS responses, including a sabotage case for every in-scope resource type (each must turn the result red) and a case proving expected data changes never alert. No AWS access needed.
2. `cdk synth` and a reviewed `cdk diff` shown to the Owner.
3. Deploy to production as a new stack only (YELLOW): nothing existing is modified.
4. Seed the baseline from the next release's record. Run in "report only" for two weeks and review every alert before relying on it.
5. Add the pre-release rule to the release checklist (E8) pointing at the sentinel's last clean run.

## 9. Decisions needed from the Owner
- Approve building it (documentation and code only), then separately approve deploying it.
- Name the alert email address and who answers it.
- Confirm that the database ledger check stays a pre-release step in v1.
