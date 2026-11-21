# Proposal: automated, demo-only deploys (GitHub Actions + AWS OIDC)

Prepared 2026-11-10. **Status: PROPOSED. Nothing has been created in AWS, GitHub or anywhere else. Owner approval is required first** (`CLAUDE.md` section 13: IAM, deploys and migrations are YELLOW).
Evidence labels: **VERIFIED** (read in this repository), **INFERRED**, **UNKNOWN** (needs a read-only check by you in AWS).

## 1. Verdict

| Part | Feasible? | Why |
|---|---|---|
| Publish the website to demo.ogevia.com from GitHub Actions | **Yes** | A reviewed script already does it with guards, capture and rollback (`test-web-release.sh`, PR #99; adapted on this branch to take the release commit). It needs only S3 and CloudFront permissions on the demo site. |
| Run database migrations on the demo database | **Yes, with one extra piece** | The demo database is private (no public endpoint, `CLAUDE.md` section 8), so a GitHub runner cannot reach it directly. Section 5 gives three ways; recommended: SSM on the existing admin host now, a small VPC migrator function later. |
| Zero production permissions | **Yes, by construction** | A dedicated role whose policy names only demo resources, plus an explicit deny on production names. See section 3. One thing must be checked first (section 8, U1): whether demo and production databases share one RDS instance. |

## 2. How the last release published the site (VERIFIED)

- Operator: you or Stella, in **AWS CloudShell**, using scripts in a pinned release folder (for the 2026-11-01 demo release: `docs/releases/2026-10-30-caregiver-readiness/STELLA_PHASE_C_DEPLOY.sh`, modes `capture`, `deploy-api`, `web`, `web-verify`, `rollback-web`).
- The `web` mode: build for TEST, upload to the demo site bucket **without deleting anything and without touching `config.json`**, create one CloudFront invalidation, then read the live site back and compare hashes (`web-verify`).
- Guards that stay: AWS account id check; TEST resource names (`Ogevia-prod-*`; "prod" in those names means **demo/TEST**) must differ from production (`Ogevia-prd-*`); the live `config.json` must not say production; the build is labelled `test` so the "TEST — synthetic data only" banner shows; a written approval reference and a time window are required; `--delete` and `s3 rm` are forbidden (tested).
- Rollback: a copy of the site is captured before publishing; `rollback` restores it (all of this is tested against test doubles in `infra/aws/test/test-web-release.test.ts`, 33 tests).
- The commit that is live is readable from the bundle: the build bakes `VITE_APP_VERSION:"<40-character commit>"` into the JavaScript (added on this branch; the 2026-11-01 records say the same was done then).
- Not reused: the CI "TEST deployment bundle" artifact. It is an October slice bundle (production-labelled web build, migrations 0010 to 0018 only) and is out of date.

## 3. Design

```
Owner clicks "Run workflow" (manual only) ──> GitHub Environment "demo" (required reviewer = you)
        │
        ▼  GitHub OIDC token (sub = repo:socalcaresservices/CarelikGlobal:environment:demo)
   AWS IAM role  ogevia-demo-deployer   (trusts ONLY that subject; 1-hour session; no long-lived keys)
        │
        ├─ S3 sync to the DEMO site bucket (no delete)        ──> CloudFront invalidation (demo distribution only)
        └─ migrations (section 5)                              ──> private demo database ogevia_sv_test
```

Controls, each independent of the others:
1. **Manual trigger only.** No deploy on push or merge. The workflow takes the commit to release as an input and refuses anything that is not on this branch's history.
2. **Gates first.** `pnpm lint`, `typecheck`, `test`, `build`, and the latest CI run on that commit must be green (the workflow reads it) before any AWS step.
3. **Human approval inside GitHub.** The `demo` Environment requires you as reviewer each time (your "explicit GO" is the click; its reference is the run id, passed to the script as `OGEVIA_DEPLOY_APPROVAL`). Deployment branches are restricted to the UX branch and `main`.
4. **OIDC, no stored AWS keys.** The role's trust policy accepts only that repository, that environment, and the AWS audience.
5. **Least privilege, demo names only,** plus an **explicit deny** on anything named like production.
6. **The script's own guards** (account, TEST/PROD separation, label, approval, window) still run, as the second wall.

## 4. Exact IAM permissions

Placeholders you fill from read-only commands in section 6, step 1: `<TEST_SITE_BUCKET>`, `<TEST_DISTRIBUTION_ID>`. Account id `300094796789` and region `us-west-2` are the ones the existing script already pins.

**Trust policy** (who may assume the role):
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::300094796789:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                      "token.actions.githubusercontent.com:sub": "repo:socalcaresservices/CarelikGlobal:environment:demo" } } }] }
```

**Permissions policy, web deploy** (all of it; nothing else is granted):
```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "DemoSiteBucketList", "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::<TEST_SITE_BUCKET>" },
  { "Sid": "DemoSiteObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::<TEST_SITE_BUCKET>/*" },
  { "Sid": "DemoInvalidate", "Effect": "Allow", "Action": ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:GetDistribution"],
    "Resource": "arn:aws:cloudfront::300094796789:distribution/<TEST_DISTRIBUTION_ID>" },
  { "Sid": "DemoStackOutputsRead", "Effect": "Allow", "Action": ["cloudformation:DescribeStacks"],
    "Resource": ["arn:aws:cloudformation:us-west-2:300094796789:stack/Ogevia-prod-WebHosting/*", "arn:aws:cloudformation:us-west-2:300094796789:stack/Ogevia-prod-ServiceVerificationApi/*"] },
  { "Sid": "WhoAmI", "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*" },
  { "Sid": "NeverProduction", "Effect": "Deny", "Action": "*", "Resource": [
      "arn:aws:cloudformation:*:*:stack/Ogevia-prd-*/*", "arn:aws:s3:::*prd*", "arn:aws:s3:::*prd*/*", "arn:aws:rds:*:*:*prd*", "arn:aws:secretsmanager:*:*:secret:*prd*" ] }
] }
```
Not granted: `s3:DeleteObject` (the script never deletes), anything on Cognito, Lambda, API Gateway, IAM, KMS, DNS, RDS, Secrets Manager. The script today also **reads** production stack outputs for its separation check; in automation that check is **replaced** by the deny above (the role cannot even read production), so the workflow runs the script with `OGEVIA_SKIP_PROD_READ=1` (a small change to add and test; not yet made).

**Added only if you choose migration option B (section 5):** `ssm:SendCommand` on exactly one instance and one SSM document, plus `ssm:GetCommandInvocation`, and `s3:GetObject/PutObject` on one artifact prefix. The database password is read by the instance (or the function), never by GitHub.

## 5. How migrations reach the private demo database

VERIFIED: the demo database is reached today only through an **SSM port-forward to a temporary admin host** (`ogevia-db-admin-temp`, t3.micro, in the private network), by an operator in CloudShell. No Lambda in the repository runs migrations. The runner code (`infra/aws/db/scripts/migrations.ts`) and each migration's rollback script already exist.

| Option | How | Cost | Risk | Recommendation |
|---|---|---|---|---|
| **A. Port-forward from the GitHub runner** | Runner opens an SSM port-forward to the admin host, then runs the migration runner with the demo app/owner login. | Admin host $8.47/month already (COST_MODEL, estimate) | Needs the session plugin and the database password on the runner; widest exposure of the three | No |
| **B. SSM Run Command (recommended now)** | Workflow uploads the migration set to an S3 prefix, then `aws ssm send-command` runs **one fixed script** on the admin host (a custom SSM document). The host reads the demo secret with **its own** instance role and applies migrations; output is returned to the workflow. | $0 extra | Depends on the admin host, which an owner decision (COST_MODEL) retires after Phase 2; the host's instance role must be checked (U2) | **Yes, short term** |
| **C. Small VPC "demo migrator" function** | CDK-defined Lambda in the private subnets, invoked by the workflow; reads only the demo secret; applies the pinned migration set. | About $0 for Lambda. If the private network has no Secrets Manager endpoint, add one (~$7.30 per endpoint-AZ per month; **UNKNOWN** whether it exists) | New infrastructure to build, test and approve | **Yes, long term** (survives the admin host's retirement) |

Rules for every option: the migration set is **pinned by file hash** in the workflow input and compared before it runs (the existing release packages already do this); a snapshot is taken first (needs `rds:CreateDBSnapshot` on the demo instance only; snapshots bill until deleted); only **demo** database names are accepted (`ogevia_sv_test`); a migration that is not additive (CLASS in its header) stops the run and waits for you.

## 6. Step-by-step AWS console setup (for you; do this only after approving)

Use the AWS account `300094796789`, region **us-west-2** for resources, as an administrator.
1. **Collect the two demo identifiers (read-only).** CloudFormation → Stacks → `Ogevia-prod-WebHosting` → *Outputs*: note the **site bucket name** and the **CloudFront distribution id** (the distribution whose domain is `d2xumch5w0izfg.cloudfront.net`). Confirm both are the *demo* ones and that neither name contains `prd`.
2. **Add the identity provider (once).** IAM → *Identity providers* → *Add provider* → *OpenID Connect* → Provider URL `https://token.actions.githubusercontent.com` → Audience `sts.amazonaws.com` → *Add provider*. (If it already exists, skip.)
3. **Create the policy.** IAM → *Policies* → *Create policy* → *JSON* → paste the section 4 permissions policy with your two values → name `ogevia-demo-deployer-policy` → create.
4. **Create the role.** IAM → *Roles* → *Create role* → *Web identity* → provider `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` → *Next* → attach `ogevia-demo-deployer-policy` → name `ogevia-demo-deployer` → create. Then open the role → *Trust relationships* → *Edit* → replace with the section 4 trust policy (this pins the repository and the `demo` environment). Set *Maximum session duration* to **1 hour**. Copy the role ARN.
5. **GitHub side.** Repository → Settings → *Environments* → *New environment* `demo` → *Required reviewers*: you → *Deployment branches*: selected branches (the UX branch and `main`) → add environment variable `AWS_ROLE_ARN` (the ARN from step 4) and `AWS_REGION=us-west-2`.
6. **Prove it before trusting it.** I add a workflow that only assumes the role and prints `sts get-caller-identity`; you run it and confirm the ARN is `ogevia-demo-deployer`. A second run must **fail** when pointed at a production bucket (the deny proves the wall).
7. (Option B only) create the SSM document and attach the Run Command permissions (I provide the exact JSON; the host's instance role is reviewed first, U2).

## 7. Monthly cost (estimates; no AWS price lookup was possible from this session)

| Item | Cost |
|---|---|
| OIDC provider, IAM role, policy | $0 |
| GitHub Actions minutes: about 15 minutes per deploy; the repository's plan sets the free allowance (**UNKNOWN**); beyond it Linux is about $0.008 per minute | $0 for up to roughly 100 minutes a month on a typical free allowance; about $1 for ten extra deploys |
| CloudFront invalidations (first 1,000 paths a month are free) | $0 |
| S3 requests and storage for the demo site and its capture | well under $1 |
| Migration path: option B | $0 extra (admin host already runs, about $8.47/month) |
| Migration path: option C | about $0 for the function; $0 to about $7.30 if a Secrets Manager endpoint must be added |
| RDS snapshot before each migration | storage-priced until you delete it (small for the demo database) |
| **Incremental total** | **$0 to about $8 per month** |

## 8. Unknowns to check read-only before approval

- **U1 (important).** Do the demo database (`ogevia_sv_test`) and the production database (`ogevia_prd`) live in **one RDS instance**? Records suggest they might (snapshots named `ogevia-prod-postgres` were taken before both TEST and production work). If so, the network and IAM walls above do not stop a *database login* from reaching the other database: the demo migration login must have `CONNECT` on `ogevia_sv_test` only (and `REVOKE CONNECT ... ON DATABASE ogevia_prd FROM` that login). Check: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier,db:DBName,class:DBInstanceClass}'`.
- **U2.** What the admin host's instance role (`OgeviaDBAdminSSMRole`) can read; it must not be able to read a production secret if it is used for demo migrations.
- **U3.** The exact bucket and distribution ids (section 6, step 1).
- **U4.** The repository's GitHub plan (free Actions minutes).

## 9. Rollback

| What | How |
|---|---|
| Website | The workflow's `capture` step stores a copy of the live site as a workflow artifact **and** keeps it on the runner; a second manual workflow (`demo-rollback`, same approval and role) runs the script's `rollback`, which restores that copy and invalidates CloudFront (tested against doubles; the first real run is the first real test). |
| Database | Every migration has a down script (CLASS stated in its header); the workflow can run it through the same path. For anything not safely reversible: restore from the pre-migration snapshot, which is a **manual owner step** (not automated). |
| The automation itself | Delete the GitHub Environment `demo` or detach the role's trust policy; no stored keys exist, so nothing else needs rotating. |

## 10. Decisions needed from you

1. Approve building the workflow and the script change (`OGEVIA_SKIP_PROD_READ`) **without creating anything in AWS yet**? (I would deliver them on this branch with tests.)
2. Migration path: **B now, C later** (recommended), or C straight away?
3. Run the read-only checks U1 to U3 (section 8), then confirm the identifiers. After that, do the console steps in section 6.

If you decline automation: build everything, then one hand-run demo package (the same script, run by you in CloudShell; the web release script, demo seed and click-through are already on this branch).
