# PR #76 deployment handoff — proposed, not executed

No deployment or live AWS change was made. This is an operator handoff, not permission to deploy.

## Release and merge order

PR #76 (`feature/caregiver-readiness`) is the owner's chosen release. It already contains the original navigation/API base from shared commit `111fc7cea90296fc430a9b9a0c1f5100fcbe6cbe`. PR #75 subsequently gained a competing readiness implementation and different migrations numbered 0039–0041. **Do not merge #75 first or merge both migration sets.** The old “#75 first” dependency is superseded by the owner's choice of #76. Review and merge #76 alone after checking its diff against current main. Leave #75 open for its author to reconcile separately. If main changes, resolve and rerun checks before merging.

Stop if any #75 readiness migrations are already installed: migration numbers are shared but contents differ. Do not rename files or edit the ledger to bypass checksum checks. Reconcile the actual schema and records before any rollout.

## Manual assignment and enforcement

Matches is an advisory candidate list. A caregiver excluded from it can still be selected manually. Missing score inputs, distance, ZIP or optional experience do not block assignment. An Administrator may authorise an availability exception for one caregiver and interval, with a recorded reason; it expires after 30 minutes for use and each use is audited. It cannot override documents, enforced service approval, tenant access, caregiver status, client authorisation, mandatory client requirements or overlap.

The table assumes an otherwise valid caregiver/client and a new dated assignment or live visit. “No” means that condition alone is not enforced; it does not certify the caregiver as safe or compliant.

| Condition | Report-only: assignment blocked? | Report-only: new visit blocked? | Active: assignment blocked? | Active: new visit blocked? |
|---|---|---|---|---|
| Missing CPR | No; warning | No; warning | Yes | Yes |
| Expired CPR | No; warning | No; warning | Yes | Yes |
| Missing TB | No; warning | No; warning | Yes | Yes |
| Unverified TB | No; warning | No; warning | Yes | Yes |
| Missing service approval | No; warning | No; warning | Yes when Service checks are On; otherwise warning | Yes when Service checks are On; otherwise warning |
| Unavailable / no approved hours | No for manual shifts; care-request assignment already requires availability | No | Yes, unless an authorised recorded override covers the interval | **Yes (0046)**, caregiver- or manager-started, unless an authorised recorded override covers the checked interval (the start moment to the shift end, or one minute for an unscheduled visit) |
| Overlapping work | Yes | Yes | Yes | Yes |

Tenant permissions, current client authorisation and mandatory client requirements remain mandatory in both modes. A live worker needs a Ready/Active Care Team record even if their account is a manager. Planned standing relationships are preparation only: they grant no work access until the caregiver is Ready/Active. Existing started visits and historical records are not rewritten by activation.

**Report-only does not satisfy the owner's requirement for current, Administrator-verified CPR and TB. Do not begin real work in report-only.** “Service checks: Off” also does not establish service approval.

## Exact rollout sequence

Use the existing operator account, Cognito pool, API, S3 evidence storage, PostgreSQL database and web hosting. No location provider, dataset or new platform is introduced. Keep credentials in the operator environment; never paste them into a PR or logs.

1. Pin the reviewed PR HEAD / resulting merge commit, inspect the production migration ledger and database version, and save the currently deployed API/web artifact identifiers. Confirm production is PostgreSQL 18 and that its installed migrations match this branch's checksums. Run the existing read-only check:

   ```bash
   bash infra/aws/scripts/deploy-production.sh check
   ```

2. With separate deployment approval, take and verify the existing RDS snapshot and a database backup suitable for a restore drill. This is the rollback anchor, not an automatic restore command. The existing snapshot step is:

   ```bash
   bash infra/aws/scripts/deploy-production.sh snapshot
   ```

3. Apply this branch's unchanged 0039–0043, then **0044_readiness_review.sql**, then **0045_manual_care_offer.sql**, then **0046_visit_start_availability.sql** (approved availability is checked when a NEW visit starts once readiness is activated, for caregiver- and manager-started visits; only a recorded administrator override lifts it; visits already in progress and historical visits are untouched), (`send_care_offer` no longer requires the caregiver to be in Matches; the readiness gate still decides at assignment), using the existing approved database connection / SSM tunnel. Set `OGEVIA_DATABASE_URL` privately to the correct target. These are the precise runner commands, from repository root:

   ```bash
   corepack pnpm@9.15.4 --filter @carelik/infra-aws db:migrate
   corepack pnpm@9.15.4 --filter @carelik/infra-aws db:verify
   ```

   The runner checks checksums and applies each migration in its own transaction. For a genuinely remote connection, the existing runner also requires `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner`; a loopback tunnel does not. Verify ledger ends at 0046 and all verification checks pass. This review did not run either command against production. Do not use `deploy-production.sh all` for this release: it includes secret, network and administrator-bootstrap operations that are unnecessary here. The broader `database` step also bootstraps accounts; use the migration runner for an existing installation.

4. API/routes next. Synthesize and inspect the CDK diff locally; deploy only the existing service-verification API stack after approval. The baseline release adds 36 readiness routes; this review adds the two authenticated GET ZIP routes, for 38 in total. Existing POST experience, preference and ZIP routes are reused. The shared API/CDK route contract must pass. Do not approve unrelated pool, database, network or hosting changes. Use the repository's `infra` step only after reviewing every stack it proposes:

   ```bash
   bash infra/aws/scripts/deploy-production.sh infra
   bash infra/aws/scripts/deploy-production.sh smoke
   ```

5. Build and publish web last through the existing web step, using the production Cognito/API environment. Preserve the previous web bundle:

   ```bash
   bash infra/aws/scripts/deploy-production.sh web
   ```

   Mutating deployment script steps require the existing `OGEVIA_DEPLOY_APPROVAL`, operator AWS credentials and configured administrator identity. Those are supplied by the operator after approval, not invented here.

6. Perform the real-login checks below before enabling work. Then finish setup and activate deliberately; migration alone does not activate enforcement.

## Setup and activation before real work

For each agency, the Administrator must designate the actual CPR and TB document types, choose each validity rule (document expiry or issue date plus agency-approved days), and record the reason. There is no invented default validity period. Request/upload actual records and verify them as Administrator; uploaded, unverified or rejected does not count. Verify their validity covers the whole planned work interval. Approve caregiver availability and service pairs explicitly; bulk service approval requires explicit selection and count confirmation. Resolve report warnings for workers and affected future work.

Read `GET /v1/document-requirements?organizationId=...` and `GET /v1/readiness?organizationId=...`; setup must be complete. The Administrator activates via the existing Settings screen or authenticated `POST /v1/readiness/activate` with `{organizationId, reason, expectedAffectedShifts}` using the current report count. A stale count refuses activation. Confirm the response and audit event. Separately turn Service checks On using `POST /v1/readiness/service-checks` with `{organizationId, enabled:true, reason}` after reviewing approvals. Verify a synthetic missing-CPR/TB assignment/start now fails, and a correctly verified worker succeeds. Do not use genuine client records for smoke tests.

ZIPs can be entered now, but no centroid dataset is loaded. Distance must read unavailable; incomplete scores must not become a fabricated number. Weights 50/25/25 and the 25-mile soft radius remain provisional. Dataset/provider approval and ranking-policy approval are separate future decisions.

## Cognito compatibility and exact remaining login checks

Roles come from PostgreSQL memberships and `/v1/me` permissions, not Cognito groups or JWT role claims. The verified Cognito `sub` is passed to `begin_request`; the existing pool/app-client/access-token validation is reused. New permission keys are in the database and shared schema. No pool/group migration is required by this change. Local tests exercised the real handler/database but supplied synthetic verified claims; **they do not prove deployed Cognito login**.

After deployment, use separate test accounts for Administrator (`organization_owner`), manager, scheduler and caregiver:

- Sign in through the production URL, including the configured MFA/temporary-password challenge where applicable; confirm callback, fresh access token, refresh, sign-out and sign-in again.
- Confirm `/v1/me` maps each Cognito sub to the expected active database membership, agency and permissions. Switching agencies must change the data and controls. A disabled membership must lose access even with an existing token.
- Administrator: load readiness settings, verify required CPR/TB, approve availability/services, review experience and save client preferences/ZIPs. Confirm `/v1/me` includes `documents.requirements.manage`, `readiness.manage` and `availability.override`.
- Manager: read warnings and use allowed matching/document tools, but required CPR/TB verification, readiness activation and availability overrides must return 403. Ordinary document review remains allowed.
- Scheduler: see only permitted scheduling/readiness functions; no setup/verification/override writes. Caregiver: own availability, experience and documents only; no other person's ZIP or administrator routes.
- Call another agency's endpoints and use a stale/expired/wrong-client token: no data leak; token errors must be 401 and authorised-scope denials 403/404. Confirm browser errors are understandable.

Stop rollout or activation on failed migrations/verification, checksum drift, the wrong database/API/pool, missing permissions, cross-tenant leakage, missing real login/MFA proof, absent current verified documents, incorrect availability/approval, unexplained CDK changes, failed rollback artifact availability or fabricated distance/score output.

## Data-preserving rollback

**Default: restore the previous compatible web/API bundles and retain the migrated database, its records, rules and enforcement settings.** The pre-review PR #76 artifact based on `ac820c223eb0614a4c4eb548ca7be492ac9025ab` is the compatibility reference; build/validate it against the retained schema before treating it as a deployable fallback. A much older build that lacks readiness behaviour is not a safe work-enabled fallback. Pause new work if the fallback cannot express the active policy. Do not disable enforcement just to make it pass.

0044's down script removes only its added functions/triggers and reverses its function patches; it removes no records, but also removes the review's extra protections. It is not the preferred live rollback.

Rolling database migrations down 0043→0039 is **not an automatic record restoration**. The scripts copy populated release tables into timestamped archive tables, check row counts, and then remove operational objects. Archives retain row values and IDs but `CREATE TABLE AS` does not retain primary keys, foreign keys, indexes, permissions or the operational links between those tables. Approved availability is converted to legacy rows, losing the new model's operational relationships. Reapplying recreates empty operational tables/default settings; it does not import archived approvals, experience, rules or enforcement settings. The round-trip tests now assert this explicitly and check archived approval IDs still join to surviving caregiver/service records. That proves retained copies, not a complete restore.

If a schema downgrade is unavoidable, freeze writes and use a tested full database restore or a separately reviewed dependency-ordered restoration plan preserving IDs and re-establishing constraints, grants, rules, settings and references. Verify records and policy before reopening work. A snapshot restore to a separate database then switching connections needs explicit operator approval and its own outage/reconciliation plan; post-snapshot writes require recovery. **Recorded rollback and archive restore (tested locally on synthetic data only; never run against production or real data).**
Do not run the `rollback/00NN_*.down.sql` files by hand when records might ever need to come back. Use the rollback runner, which runs 0046 down to 0039 (or a later target) as ONE transaction and records the attempt:
`OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner OGEVIA_DATABASE_URL=... corepack pnpm@9.15.4 --filter @carelik/infra-aws db:rollback-readiness [target]` (BACKUP REQUIRED; it prints `ATTEMPT ID: <uuid>`).
Each attempt gets a **unique attempt id** and a **complete manifest**: one row per archive slot (25 for 0039-0046), including slots that held **zero records** (no archive table, `source_rows = 0`), the rows each source table held just before the rollback, and the archive table and row count that
holds them. Every archive table is tagged with its attempt id. Archives are never grouped by time or picked "newest per table", so two rollbacks seconds or minutes apart cannot be mixed.
To restore (after re-applying the migrations and after a backup):
1. `psql -f infra/aws/db/restore/readiness_list_recovery_sets.sql` lists the attempts (newest first).
2. `psql -v ON_ERROR_STOP=1 -c "set ogevia.recovery_attempt = '<attempt id>'" -f infra/aws/db/restore/readiness_restore_from_archives.sql` as the migration owner.
It refuses (and changes nothing): no, invalid or unknown attempt id; an attempt that is not the newest (unless `ogevia.recovery_allow_older = 'yes'` is also set); an incomplete manifest; an archive that is missing, whose row count differs from the manifest, that is tagged for a **different attempt**
(mixed across attempts), or that is tagged for this attempt but not in its manifest; a destination table that is non-empty and differs from the archive; a destination whose slot held **zero records** in that attempt but now holds rows (never mixed in); and a database with no recorded attempt (archives from a hand-run down script keep their data but are not restorable by the script).
A rerun of an already-restored attempt is accepted and changes nothing. One transaction, same ids, parents first, foreign keys checked by the database. It restores experience tags/experience/reviews/client wishes, ZIPs, CPR/TB designations and validity rules (and history), service approvals, availability overrides,
setting-change history and readiness skipped-date rows. It never touches the enforcement setting: enforcement stays Off until the owner activates it. Not restored (a person decides): availability request history and version counters, derived review flags.
Guarded case: attempt 1 archived a service approval and attempt 2, seconds later, had none; restoring attempt 2 does not bring back attempt 1's approval, and borrowing an archive across attempts is refused.
Proven by `readiness-restore.db.test.ts` (two rollbacks seconds apart, manifest with zero-record slots, listing, incomplete/missing/changed/mixed archives, a non-empty zero-record destination, a broken dependency, safe reruns, the older attempt, no recorded attempt) and by a real `psql` run of the CLI and scripts on a scratch database. Not tested on RDS or real data; rehearse on a restored snapshot first. No live restore was run.
