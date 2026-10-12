# CLAUDE.md --- Ogevia AWS Master Build Directive

**Status:** AUTHORITATIVE\
**Effective date:** 2026-09-30\
**Project:** Ogevia / CareLikGlobal\
**Repository:** `socalcaresservices/CarelikGlobal`\
**Primary AWS region:** `us-west-2`\
**Purpose:** Give Claude Code one unambiguous technical, security,
financial, and execution direction for Ogevia.

------------------------------------------------------------------------

# 0. STANDING RULES (added 2026-10-09; take precedence over sections 14 and 17 as a starting instruction)

## Current task first
- Follow the owner's current explicit instructions. Historical migration phases (section 14) and the "start with Phase 0"
  instruction (section 17) do **not** restart automatically; they are history unless the owner reopens them.
- Verify checkout freshness and the intended branch before working: `git fetch origin main`, compare with the current feature or PR
  base, and confirm the head commit. A stale checkout must never be used to describe current state.
- Invalid or expired container credentials mean AWS access is unavailable. They do not prove that deployed resources are missing.
  Do not request credentials until a specific authorised task actually requires live AWS access.

## Reuse existing tools
- Inspect existing functionality and the current stack first. Reuse or extend suitable tools, libraries and services already used.
- Do not introduce duplicate platforms or propose replacements because they are familiar or easier.
- A new tool requires a demonstrated gap, alternatives considered, cost and migration impact, and owner approval before adoption.
- Do not reopen settled hosting or architecture decisions (CloudFront/AWS web hosting, API route set, database choice) without a
  concrete need and explicit owner instruction.

## Release process
- Every change follows `docs/TESTING_AND_RELEASE_PROCESS.md` (adopted by the owner 2026-10-13): Phase A development, B local harness,
  C pilot/test, D user acceptance, E production approval. No deployment proposal without the completed release checklist
  (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`), and no deployment without `pnpm lint`, `pnpm typecheck`, `pnpm test`
  (plus the database and API suites it names), local harness verification, pilot validation and the owner's explicit GO.

## Accurate records
- Distinguish **proposed**, **implemented**, **tested** and **deployed**. Implemented never means deployed.
- Do not overwrite current records with findings from a stale checkout.
- Save the owner's briefs, decisions and implementation notes in repository documentation (see `docs/releases/`).
- Report the tests actually run and the evidence; do not infer production success.

------------------------------------------------------------------------

## 1. Authority and supersession

This file is the current source of truth for the Ogevia build.

If an older document, prompt, comment, plan, or code note conflicts with
this directive, **this directive wins unless the owner explicitly
approves a change**.

Do not revive superseded architecture choices merely because they exist
in repository history.

Important superseded directions include: - Do **not** redesign Ogevia
around DynamoDB. - Do **not** rebuild the existing Service Verification
user interface. - Do **not** create a second temporary backend
architecture that will later be discarded. - Do **not** cancel Supabase
or Netlify during migration. - Do **not** treat electronic Service
Verification as the same thing as California EVV/Sandata. - Do **not**
assume AWS usage alone makes the application HIPAA compliant.

------------------------------------------------------------------------

# 2. Business objective

Ogevia is being built as a low-cost care-services operations platform.
SoCal Care Services is the first tenant.

The immediate business problem is reliable electronic service
documentation. Caregivers currently create avoidable administrative risk
through missed clock-ins, missed clock-outs, paper documentation errors,
and inconsistent signatures.

The first production milestone is therefore **Service Verification**,
not a full rewrite of every Ogevia module.

The production workflow is:

1.  Caregiver signs in with an individual account.
2.  Ogevia shows only assigned/authorized clients and services.
3.  Caregiver starts a visit.
4.  The server records the authoritative start timestamp.
5.  Caregiver ends the visit.
6.  The server records the authoritative end timestamp.
7.  Client, parent, guardian, or authorized representative reviews and
    confirms the visit.
8.  Signature/evidence is stored securely.
9.  The visit becomes locked for ordinary editing.
10. Any later correction preserves the original and creates a complete
    audit record.
11. The visit becomes available for reconciliation and billing review.

This workflow must remain authorization-aware, auditable, and
inexpensive to operate.

------------------------------------------------------------------------

# 3. Product scope: preserve what already works

The repository already contains substantial Ogevia product work.

## KEEP

-   Existing React/TypeScript Ogevia frontend.
-   Existing Service Verification screens and user flow.
-   Existing client, caregiver, assignment, service, authorization,
    visit, signer, correction, and audit concepts where sound.
-   Existing business rules that prevent silent correction of
    signed/verified visits.
-   Existing internal client-code approach where appropriate.
-   Existing manager review and reconciliation concepts.
-   Existing tests and production-quality validation patterns.

## MIGRATE / REPLACE

The current Supabase-specific backend dependencies will be replaced for
the production AWS path: - Supabase Auth → Amazon Cognito. - Direct
browser-to-Supabase RPC calls → Ogevia API through API Gateway and
Lambda. - Supabase PostgreSQL production dependency → Amazon RDS
PostgreSQL. - Supabase Storage for visit signatures → private Amazon
S3. - Supabase-specific server/backend logic → Lambda/service layer and
PostgreSQL functions/queries where appropriate.

## KEEP TEMPORARILY

-   Netlify remains the frontend host during migration unless a later
    approved decision moves hosting to AWS.
-   Supabase remains available as a development/migration reference
    until AWS parity is proven and migration is accepted.
-   Existing email tooling may remain only for non-PHI/generic
    notifications unless separately approved for PHI handling.

Do not remove old infrastructure until the replacement has passed
functional, security, data-integrity, and rollback gates.

------------------------------------------------------------------------

# 4. Final target architecture

``` text
Caregiver / Administrator / Client Representative
                    |
                    v
          Existing Ogevia React UI
                    |
                    v
             Amazon Cognito
                    |
                    v
          Amazon API Gateway
                    |
                    v
              AWS Lambda
              /        \
             v          v
     RDS PostgreSQL   Amazon S3
      structured       signatures /
         data          evidence
             \          /
              v        v
                AWS KMS
                    |
                    v
     CloudWatch / CloudTrail / Audit
```

Supporting controls: - Amazon VPC and private networking. - AWS Secrets
Manager. - KMS encryption. - RDS backups. - S3
encryption/versioning/lifecycle controls. - CloudWatch alarms and finite
log retention. - CloudTrail. - AWS Budgets/cost alerts. -
Least-privilege IAM. - WAF only when justified for the production
exposure model. - No public RDS endpoint.

------------------------------------------------------------------------

# 5. Why PostgreSQL is the database decision

RDS PostgreSQL is the production database direction.

Do not substitute DynamoDB unless the owner explicitly reopens the
architecture decision.

Reasons: - Ogevia already has relational PostgreSQL/Supabase logic. -
Service Verification depends on relationships among organizations,
users, caregivers, clients, assignments, services, authorizations,
visits, signatures, corrections, and audits. - Existing RPC/business
logic can be translated more directly to PostgreSQL + Lambda than
redesigned for DynamoDB. - This reduces rewrite risk and preserves prior
engineering investment.

------------------------------------------------------------------------

# 6. Infrastructure as code decision

Use **AWS CDK v2 with TypeScript** for Ogevia infrastructure as code.

Reason: - The repository is already a TypeScript/pnpm monorepo. - CDK
keeps the infrastructure in the same language/toolchain. - CDK deploys
through CloudFormation and gives Ogevia repeatable infrastructure
definitions. - Existing manually created AWS resources can be referenced
or deliberately imported after verification.

Proposed repository structure:

``` text
CareLikGlobal/
├── apps/
├── packages/
├── supabase/                  # migration/reference until retired
├── docs/
│   └── aws/
│       ├── CURRENT_AWS_INVENTORY.md
│       ├── MIGRATION_PLAN.md
│       ├── COST_MODEL.md
│       ├── SECURITY_DECISIONS.md
│       └── DEPLOYMENT_RUNBOOK.md
├── infra/
│   └── aws/
│       ├── bin/
│       ├── lib/
│       ├── test/
│       ├── package.json
│       ├── tsconfig.json
│       └── cdk.json
└── CLAUDE.md
```

Do not use Terraform in parallel unless explicitly approved. Ogevia
needs one infrastructure source of truth, not competing IaC systems.

------------------------------------------------------------------------

# 7. Last-known AWS foundation --- VERIFY LIVE BEFORE USING

The following resources were created or worked on manually during the
AWS foundation build. They are **last-known state**, not permission to
assume they still exist or are correctly configured.

Claude must verify them with read-only AWS CLI/API calls before writing
CDK references or import definitions.

Known identifiers: - Region: `us-west-2` - VPC:
`vpc-0ee9df0c38297cbc1` - Database-admin security group:
`ogevia-db-admin-sg` - Security group ID: `sg-00e01e2ca80442c1f` - SSM
VPC endpoint: `vpce-09dff848221f90105` - SSM Messages VPC endpoint:
`vpce-0cfe984c8b634eb0d` - IAM role: `OgeviaDBAdminSSMRole` - Instance
profile: `OgeviaDBAdminProfile` - Temporary admin host tag/name used
during setup: `ogevia-db-admin-temp` - RDS PostgreSQL target/name
discussed: `ogevia-postgres`

IAM Identity Center administrative access and MFA were also configured
during the foundation work.

Claude must determine the actual current state of: - VPC CIDR and DNS
settings. - public/private subnet layout and AZs. - route tables. -
internet gateway. - NAT gateways, if any. - VPC endpoints. - security
groups and inbound/outbound rules. - RDS instance/cluster existence and
status. - RDS engine/version/class/storage/encryption/public
accessibility. - DB subnet groups and parameter groups. - Secrets
Manager entries by metadata only. - KMS keys/aliases. - CloudTrail. -
CloudWatch log groups/alarms. - S3 buckets. - Cognito pools/clients. -
API Gateway APIs. - Lambda functions. - AWS Budgets. - CDK
bootstrap/CloudFormation stacks.

Never print or retrieve secret values merely to document the
environment.

------------------------------------------------------------------------

# 8. HIPAA/security direction

HIPAA is a production design constraint.

AWS services must be used under the applicable AWS BAA and configured
according to the shared-responsibility model before production ePHI is
introduced.

Rules: 1. No production PHI/ePHI until the BAA/security gate is
confirmed. 2. No PHI in source code, Git commits, Claude prompts, issue
text, build artifacts, URLs, or unnecessary logs. 3. Never commit
credentials, access keys, database passwords, tokens, private keys, or
secret values. 4. Use Secrets Manager or approved environment injection
for secrets. 5. Encrypt data at rest. 6. Require TLS in transit. 7. RDS
must remain private, not publicly accessible. 8. Use individual user
identities. No shared/generic caregiver logins. 9. Apply least privilege
to IAM and application authorization. 10. Tenant/organization boundaries
must be enforced server-side. 11. Do not trust client/browser timestamps
for authoritative visit start/end. 12. Do not log signature image
payloads. 13. Signed visit records are not silently overwritten. 14.
Corrections must retain original values, corrected values, actor,
timestamp, and reason. 15. S3 signature objects must be private and
accessed only through controlled application paths. 16. Security changes
that weaken encryption, network isolation, authentication,
authorization, logging, or audit controls require explicit approval.

------------------------------------------------------------------------

# 9. Service Verification data model --- minimum production vertical slice

The AWS production database must support, at minimum:

-   `organizations`
-   `users`
-   `caregivers`
-   `clients`
-   `services`
-   `client_assignments`
-   `authorizations`
-   `service_visits`
-   `visit_confirmations`
-   `visit_signature_metadata`
-   `visit_corrections`
-   `audit_events`

Exact table names may preserve existing canonical schema names if that
reduces migration risk.

Required business invariants: - Organization/tenant ownership on
relevant records. - Caregiver can see only permitted assignments. -
Service must be valid for the selected client. - Authorization
validation occurs server-side. - At most one open visit per caregiver
when that is the established business rule. - Start/end timestamps are
server authoritative. - End cannot precede start. - Confirmation records
who signed, role, method, timestamp, and what visit state was
confirmed. - Signature binary belongs in S3; database stores
metadata/key/reference, not base64 image data. - Signed/confirmed visits
are immutable through ordinary update paths. - Corrections are
append-only/audited. - No-signer/exception path remains available for
administrator review and must not silently become billable. - Billing
approval remains a human-controlled step.

------------------------------------------------------------------------

# 10. California EVV boundary

Service Verification and California EVV are separate concerns.

The first AWS production milestone is Ogevia electronic Service
Verification.

Do not claim or code Ogevia as a replacement for CalEVV/Sandata unless
the applicable DDS/regional-center requirements and integration
requirements have been separately verified and approved.

Deferred unless explicitly activated: - Direct Sandata integration. -
GPS/geofencing. - Automatic payer submission. - Automatic billing
approval. - AI decisions that determine whether a visit is billable.

Design the data model so later EVV reconciliation/integration is
possible without rebuilding Service Verification.

------------------------------------------------------------------------

# 11. Financial architecture rules

Ogevia must remain economical for a workforce with many part-time
caregivers and turnover.

Financial principles: - Avoid per-caregiver SaaS licensing where the AWS
architecture can provide the capability economically. - Prefer
serverless/usage-based services for API/application compute. - Keep
fixed monthly infrastructure low. - Do not create a NAT Gateway merely
by default. It requires a documented technical need and owner
approval. - Do not introduce ECS, EKS, OpenSearch, ElastiCache, Aurora,
dedicated always-on application servers, or paid third-party
observability without a documented need and cost approval. - RDS
PostgreSQL is an intentional exception to the serverless preference
because preserving relational PostgreSQL logic materially reduces
development/rewrite risk. - Right-size RDS for the actual stage; do not
overprovision for hypothetical scale. - Use finite CloudWatch
retention. - Use S3 lifecycle policies where appropriate. - Create AWS
Budget/cost alerts before production. - Every proposed AWS resource must
be documented with: - purpose, - whether it creates fixed cost, -
estimated development monthly cost, - estimated initial production
monthly cost, - scaling cost driver, - cheaper alternative considered. -
Any material increase in recurring cost requires approval before
deployment.

Claude must optimize **total cost of ownership**, not just AWS invoice
cost. A cheaper AWS service is not actually cheaper if it causes a large
application rewrite.

------------------------------------------------------------------------

# 12. Claude Code's role

Claude Code is the implementation and automation engine, not the
architecture decision-maker.

Claude should: - inspect the repository, - inventory AWS, - write/update
documentation, - build CDK infrastructure code, - translate existing
Supabase backend logic, - create database migrations, - build Lambda/API
code, - create Cognito integration code, - build S3 signature storage
integration, - write automated tests, - run lint/typecheck/test/build, -
run `cdk synth`, - run read-only AWS verification, - run `cdk diff` when
safe, - report cost/security consequences, - maintain migration
checklists, - prepare deployment commands and change plans.

Claude must not independently change the approved architecture.

When Claude discovers a conflict, it must stop that portion of the work
and report: 1. what it found, 2. why it conflicts, 3. options, 4.
security impact, 5. cost impact, 6. recommended technical resolution, 7.
whether the resolution changes this master directive.

------------------------------------------------------------------------

# 13. Automation permission model

## GREEN --- Claude may do automatically

-   Read repository files.
-   Search repository code.
-   Run git status/diff/log.
-   Use read-only AWS CLI/API calls.
-   Create documentation.
-   Create/update local source files on a feature branch/worktree.
-   Create CDK code without deploying it.
-   Create SQL migrations without executing them against production.
-   Create Lambda/API/application code.
-   Create tests.
-   Run local lint/typecheck/test/build.
-   Run `cdk synth`.
-   Run static/security analysis that does not transmit PHI.
-   Generate cost inventories/estimates.
-   Produce migration mappings.
-   Produce deployment plans.
-   Inspect CloudFormation/CDK state read-only.

## YELLOW --- prepare automatically, execute only after explicit approval

-   `cdk bootstrap`
-   `cdk import`
-   CloudFormation imports.
-   `cdk deploy`
-   applying SQL migrations to AWS databases.
-   changing IAM policies/roles.
-   changing security-group rules.
-   creating/deleting/modifying RDS.
-   creating/modifying Cognito.
-   creating/modifying API Gateway/Lambda/S3/KMS/Secrets Manager.
-   DNS changes.
-   changing Netlify/Supabase production configuration.
-   production data migration.
-   enabling/disabling WAF or other billable controls.
-   any operation that creates meaningful recurring cost.

For yellow actions Claude should prepare the exact command/change set,
explain impact, and wait.

## RED --- never do without a separately explicit instruction and backup/rollback plan

-   Delete production/stateful data.
-   Delete RDS databases or snapshots.
-   Delete S3 signature/document data.
-   Disable encryption.
-   Make RDS public.
-   Expose secrets.
-   Disable audit logging to solve an error.
-   Force-push `main`.
-   Rewrite repository history.
-   Drop production tables.
-   Turn off authorization/tenant isolation.
-   Bypass security controls to make tests pass.
-   Use `--dangerously-skip-permissions` as the normal operating mode.
-   Cancel Supabase or Netlify before migration acceptance.

------------------------------------------------------------------------

# 14. Build phases

## PHASE 0 --- Reconcile reality

Goal: establish an accurate source of truth before any more AWS
creation.

Claude: 1. Verify AWS caller identity and `us-west-2`. 2. Inventory
current AWS resources read-only. 3. Inventory current repository
architecture. 4. Map existing Supabase dependencies. 5. Compare live AWS
state against this directive. 6. Generate: -
`docs/aws/CURRENT_AWS_INVENTORY.md` - `docs/aws/MIGRATION_PLAN.md` -
`docs/aws/COST_MODEL.md` - `docs/aws/SECURITY_DECISIONS.md` 7. Classify
every relevant resource/component: - KEEP EXISTING - REFERENCE FROM
CDK - IMPORT INTO CDK - CREATE NEW - MIGRATE FROM SUPABASE - DEFER -
RETIRE AFTER CUTOVER 8. Do not deploy.

Exit gate: architecture owner reviews the inventory and adoption/import
plan.

## PHASE 1 --- Establish CDK source of truth

Goal: create `infra/aws` without accidentally duplicating existing
infrastructure.

Claude: 1. Create a TypeScript CDK v2 project compatible with the pnpm
monorepo. 2. Model new infrastructure. 3. Reference existing resources
where ownership should remain external initially. 4. Prepare deliberate
import plans for resources that should become CDK-managed. 5. Add
removal protection/retention for stateful production resources. 6. Add
CDK tests/assertions. 7. Run synth and diff. 8. Do not import or deploy
without approval.

Exit gate: clean synth, reviewed diff, no unintended
replacement/deletion.

## PHASE 2 --- PostgreSQL Service Verification foundation

Goal: create the minimum AWS database schema needed for Service
Verification.

Claude: 1. Extract the existing Supabase Service Verification schema,
RPCs, constraints, and tests. 2. Produce a source-to-target mapping. 3.
Preserve business invariants. 4. Create idempotent PostgreSQL
migrations. 5. Create migration verification queries. 6. Create rollback
strategy. 7. Do not migrate real PHI during development.

Exit gate: schema and logic pass automated tests and parity review.

## PHASE 3 --- Authentication

Goal: replace Supabase Auth for the production vertical slice.

Claude: 1. Build Cognito infrastructure/code. 2. Define
groups/roles/claims required by Ogevia. 3. Preserve individual caregiver
identities. 4. Implement server-side authorization mapping. 5. Update
frontend auth adapter with minimal UI disruption. 6. Keep old auth
available until cutover.

Exit gate: login/session/logout/password flow and authorization tests
pass.

## PHASE 4 --- API and Lambda service layer

Goal: remove direct browser access to privileged database operations.

Initial endpoints/operations must support: - current active visit, -
assigned clients, - authorized services, - start visit, - end visit, -
confirm visit, - no-signer exception, - manager review/correction as
required.

Claude: 1. Translate current Supabase RPC behavior rather than inventing
new semantics. 2. Use server-authoritative timestamps. 3. Enforce
tenant/user/assignment/authorization controls. 4. Use structured
validation and safe error responses. 5. Prevent PHI leakage into logs.

Exit gate: API contract and integration tests match required Service
Verification behavior.

## PHASE 5 --- S3 signature/evidence storage

Goal: replace Supabase Storage for signatures.

Claude: 1. Create private encrypted S3 design. 2. Define object key
structure without unnecessary PHI in object names. 3. Store signature
metadata in PostgreSQL. 4. Prevent public access. 5. Add
retention/versioning/lifecycle decisions. 6. Do not enable irreversible
controls such as Object Lock without explicit approval.

Exit gate: authorized upload/read works; unauthorized access fails;
audit path exists.

## PHASE 6 --- Connect the existing Ogevia UI

Goal: preserve screens while changing backend adapters.

Claude: 1. Introduce an AWS-backed service/API adapter. 2. Replace
direct Supabase calls only for the migrated Service Verification
vertical slice. 3. Preserve user flow and visual behavior unless a
change is necessary for security or correctness. 4. Keep feature
flags/configuration for controlled migration if useful. 5. Do not
perform a broad UI rewrite.

Exit gate: end-to-end workflow works against AWS.

## PHASE 7 --- Security, reliability, observability and cost gate

Goal: prove the system is safe and affordable before production.

Validate: - BAA/security prerequisite. - encryption. - private
database. - IAM least privilege. - Cognito authorization. - tenant
isolation. - S3 private access. - CloudTrail. - CloudWatch alarms/log
retention. - backups and restore procedure. - secret handling. - audit
trail. - failure/retry behavior. - cost model and budget alerts. - no
PHI leakage in logs.

Exit gate: documented sign-off.

## PHASE 8 --- Controlled cutover

Goal: activate AWS Service Verification without losing rollback
capability.

Claude prepares: - migration plan, - backup, - data validation, - smoke
tests, - rollback plan, - cutover checklist, - post-cutover monitoring.

Do not retire Supabase/Netlify components until the replacement has met
the acceptance gate.

------------------------------------------------------------------------

# 15. Required engineering quality gate

Before proposing a deploy: - `pnpm lint` - `pnpm typecheck` -
`pnpm test` - `pnpm build` - CDK tests - `cdk synth` - reviewed
`cdk diff` - migration tests - API integration tests -
authorization-negative tests - tenant-isolation tests -
signature-access-negative tests

If a pre-existing unrelated failure prevents the full gate, document it
separately. Do not weaken the gate or hide the failure.

------------------------------------------------------------------------

# 16. Change-management protocol

At the end of every Claude execution phase, output:

## COMPLETED

Exactly what changed.

## FILES CHANGED

Paths and purpose.

## AWS CHANGES

State `NONE` unless AWS was actually modified.

## COST IMPACT

Expected new fixed and variable cost.

## SECURITY IMPACT

What security posture changed.

## TESTS

Commands run and results.

## RISKS / OPEN QUESTIONS

Only unresolved items.

## NEXT APPROVAL GATE

The exact action that requires owner/architect approval.

Do not bury destructive or billable changes inside a long summary.

------------------------------------------------------------------------

# 17. Immediate instruction to Claude Code (HISTORICAL; see section 0)

The original starting instruction was: start with **Phase 0**. It does not restart automatically.

Do not deploy.

Use read-only AWS commands to establish current state. Inspect the
repository thoroughly enough to map the current Service
Verification/Supabase implementation.

Then create/update: - `docs/aws/CURRENT_AWS_INVENTORY.md` -
`docs/aws/MIGRATION_PLAN.md` - `docs/aws/COST_MODEL.md` -
`docs/aws/SECURITY_DECISIONS.md`

After Phase 0 documentation is complete, Claude may also scaffold the
local `infra/aws` TypeScript CDK project **without deploying or
importing resources**, provided the inventory shows no conflict.

Run local quality checks and `cdk synth`.

Then stop at the first AWS mutation/import/deployment gate and present
the proposed change.

The objective is speed through automation **without duplicating
infrastructure, creating surprise cost, or weakening security**.
