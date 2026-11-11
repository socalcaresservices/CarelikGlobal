# TEST database separation and release package — prepared, not executed

## Decision and target
Reuse existing `ogevia-postgres` for TEST if one bounded metadata/catalog inventory confirms it can accommodate a new dedicated TEST database. Do not provision a third instance. Do not overwrite any database, copy an entire instance, restore a production snapshot, read client rows, or delete anything from either existing server.

Build the new TEST environment from the repository migrations and synthetic harness fixtures. Do not copy the current `ogevia_sv_test`: its data classification is unverified, and the owner excludes real caregiver/client data from this work. Retain that old database unchanged as a rollback target.

## Facts supplied by the owner
- Both live API Handlers currently use `ogevia-prod-postgres`: TEST database `ogevia_sv_test`; production database `ogevia_prd`.
- Candidate `ogevia-postgres`: PostgreSQL 18.3; available; private; encrypted; db.t4g.micro; 20 GiB gp3; Single-AZ; seven-day backups; deletion protection enabled.
- Both instances use VPC `vpc-0ee9df0c38297cbc1`. Candidate subnet group: `ogevia-private-db-subnets`; parameter group: `default.postgres18`.
- Candidate SG `sg-0bc0f1315fd0feaf2` allows 5432 only from `sg-06b4533f52b1bd2fe` and admin SG `sg-00e01e2ca80442c1f`. No public inbound address range.
- Candidate tags: Application=Ogevia, Name=ogevia-postgres. These tags do not establish exclusive ownership or absence of stored data.
- All supplied hourly maximum DatabaseConnections samples are zero for the reported week. Neither of the two listed API Lambdas uses this candidate endpoint. These facts support inactivity, not emptiness.
- Application change is at f4316c5; continuation head 7b4221256346cb50394952224c13509da6b8ffad passed CI run 439: 3,777 tests, zero failed/skipped, with lint/typecheck/build/harness green. This is evidence for the current shared-database configuration, not for a future separation patch.

## One bounded inventory stage
The operator performs these checks in one session, returns one report, and stops if access is unavailable. No starting hosts, attaching SGs, retrieving client records, or creating resources during inventory.

1. Identify an already running, SSM-online admin host with the already permitted admin SG. Record the candidate instance's owner/stack, endpoint, master-secret ARN metadata and SGs. Do not print or return secret values.
2. Through the existing approved TLS connection to the candidate only, run this catalog query. The connection setup must already exist; this package does not authorize changing networking or retrieving credentials merely to discover a path.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT current_database(), inet_server_addr(), inet_server_port();
SELECT datname, pg_get_userbyid(datdba) AS owner, datallowconn
FROM pg_database
WHERE NOT datistemplate
ORDER BY datname;
SELECT datname, usename, application_name, client_addr, state
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND pid <> pg_backend_pid();
ROLLBACK;
```

This queries metadata only; it deliberately excludes SQL query text and application tables. If `ogevia_sv_test` already exists on the candidate, do not overwrite it or assume it is disposable. Inventory its ownership before naming a fresh target. If the current access path is unavailable or ownership remains unclear, return that single blocker; do not issue another series of speculative CloudShell probes.

## Required implementation before a cutover can be approved
A repository hazard was found: **PRD is built with `...PROD`**, inheriting `PROD.existing`. Editing the TEST foundation in place would therefore also change the synthesized production database target. Before changing TEST:

- Preserve an independent production foundation containing its existing RDS host, instance, SGs, credential references and ownership information.
- Set only TEST's RDS reference to `ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com`, with the verified candidate instance ownership and credential metadata. Do not invent an ARN or a CloudFormation owner from its two tags.
- Determine whether the current TEST application secret is exclusive to TEST. Reusing it would avoid an additional secret/endpoint-policy change, but must not disrupt another consumer. Never reuse the production application credential.
- Identify TEST and production Lambda SGs before proposing a network rule. Do not assume their application SGs are distinct. Any proposed TEST ingress goes only on candidate SG `sg-0bc0f1315fd0feaf2`, never on production RDS SG `sg-00530a1f4f7648e65`.
- Enumerate any shared Secrets Manager endpoint policy/IAM dependency. If a new credential requires changing that shared resource, show that diff and its production impact explicitly; it is not silently included in a TEST-only change.
- Update the existing DB operator script's target instance, SG, access and expected-ledger pins for the isolated target. The old shared-instance script cannot be reused unchanged.
- Test that production templates retain their original host, database, secret, security groups, routes and IAM permissions. Test the TEST target and role/tenant isolation. Run lint, typecheck, build, full test:all with zero failures/skips, harness checks and final CI on that candidate commit.
- Generate a fresh expected-only deployment gate and asset/hash pins for the separation candidate. The current UX gate allows only Handler code and three routes; it must not be bypassed to accept environment/network/IAM changes.

No application configuration change is made by this proposal. The separation candidate is not implemented or claimed tested yet.

## Proposed execution order — requires a later explicit GO
| Step | Exact scope | Production impact |
|---|---|---|
| Preserve baseline | Capture TEST API template/config/asset reference and TEST web files; record the production configuration for comparison without changing it | Read-only; no production data |
| Protect candidate contents | Preserve existing candidate databases; take an appropriate backup only after its contents/ownership are classified | Candidate I/O; no production-instance snapshot |
| Prepare fresh TEST database | Create a new, nonexisting TEST database and dedicated application role on the candidate; apply the existing ledger-aware migrations; seed only synthetic fixtures | Writes candidate only; existing candidate consumers could be affected if inventory was incomplete |
| Prepare TEST access | Only the reviewed candidate ingress and TEST credential/grants; separately identify any shared endpoint-policy changes | Shared policy changes can affect production and require explicit review; no production RDS rule or login change |
| Verify before cutover | Check exact target server/database, ledger/checksums, grants, roles and tenant isolation on the fresh database | Candidate only |
| Cut over TEST API | Change only the approved TEST stack/configuration; keep `ogevia_prd` and all production resource settings fixed | TEST may be unavailable during cutover; no production writes intended; shared networking remains a dependency |
| Publish TEST redesign | Publish only TEST web bucket/distribution using the existing guarded release process | TEST web only |
| Acceptance | Owner/caregiver synthetic sign-in, schedule, Start/End/Confirm, CSV check/confirm, labels, one headline count, explicit CPR/TB setup; duplicate routes stay absent | TEST only; physical-phone check remains an owner task |
| Production comparison | Confirm production configuration is unchanged without opening real client/caregiver records | Read-only metadata |

Do not promise zero production risk: the VPC, access host or endpoints can remain shared even after separating RDS. Separating the database removes the current shared RDS CPU/I/O/connection dependency after cutover, not every shared dependency.

## Rollback
Stop TEST writes if verification fails. Restore the captured TEST web files and previous TEST API template/configuration/credential reference. The original `ogevia_sv_test` on `ogevia-prod-postgres` stays unchanged and available for this fallback. Confirm the TEST endpoint and synthetic workflow after rollback.

Never restore/reboot/modify the production RDS instance, delete either database, or automatically remove the isolated candidate. Failed-attempt synthetic data remains on the candidate for investigation. Reverting TEST to the old host restores the old shared-resource risk; report that explicitly.

## Cost and approval boundary
Reusing an instance that is already running adds no third-instance compute allocation. Existing instance/storage charges continue. Storage growth, backup retention, credential storage and I/O may still change usage costs. No new-instance price or monthly savings is asserted, and no existing resource will be stopped or deleted to claim savings.

The original proposal's new `ogevia-test-postgres` instance, production-instance snapshot, copy of an unclassified TEST database, promised 15–30-minute outage, and later deletion are superseded by this plan. A reliable cutover window and final commands require the bounded inventory and tested separation candidate first.

**Current stage: application ready; separation proposal prepared; separation not implemented; deployment not authorized or started.** The next executable work is the single inventory stage, followed by the tested TEST-only candidate and one consolidated execution approval. No additional owner checklist or signature document is requested.

## Local preparation completed after this proposal
The configuration inheritance protection is now implemented locally: independent TEST and production foundation objects, with deep copying of nested database, security-group and subnet settings. Regression reproduced first (1 failed / 1 passed), then 2/2 passed after the fix. Infra typecheck passes. Comparing every serialized environment value with commit 7b42212 confirms no endpoint, secret, SG, route switch or other configuration value changed. No cutover or AWS action occurred. The preparation change is being published on the existing PR #108 branch; its own CI result must be read before relying on it.
The single inventory script is delivered as TEST-inventory-once.sh. It makes only read-only AWS metadata calls, then optionally reads database catalogs through an already configured, verify-full TLS service for the exact candidate endpoint. If that connection is unavailable it exits with one explicit access blocker rather than authorizing networking changes or guessing credentials.
