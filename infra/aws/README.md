# Ogevia AWS CDK (v2, TypeScript)

Authored from scratch per CLAUDE.md §6. `legacy-cdk-out`-style output in `cdk.out/` is the old, source-less reference and is not used.
Synth output goes to `cdk.synth.out/` (gitignored). **Nothing here has been bootstrapped, imported, or deployed.**

Stacks (`Ogevia-<stage>-*`): Evidence (KMS + private versioned S3), Database (private encrypted RDS PostgreSQL 16, SSL forced, deletion-protected), Auth (Cognito, admin-created users, groups), Api (HTTP API + Cognito JWT authorizer + 8 Phase-4 routes -> **501 placeholder Lambda**), Observability (alarms, optional budget).

Deliberately absent: CloudFront/WebHosting (Netlify stays), NAT, WAF, interface endpoints (cost approval needed).

Synth (no AWS access needed; IDs below are placeholders — use verified values for a real diff):
`npx cdk synth -c vpcId=... -c azs=us-west-2a,us-west-2b -c privateSubnetIds=a,b -c dbAdminSecurityGroupId=sg-... [-c stage=prd -c frontendOrigins=https://app.example -c alarmEmail=... -c monthlyBudgetUsd=...]`

Known gaps before any deploy: VPC Lambda reaching Secrets Manager/KMS needs interface endpoints or NAT (decision pending); existing VPC/SG referenced by ID only (live state unverified); Lambda handler not implemented; Postgres migrations not written.
