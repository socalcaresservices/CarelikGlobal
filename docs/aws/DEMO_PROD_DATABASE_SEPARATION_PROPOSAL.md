# Finding U1 and proposal: demo and production on one database server

**Status:** PROPOSAL. Nothing created or changed. Independent of the auto-deploy decision.

## Finding
- **VERIFIED from the repository records (not live):** the demo database `ogevia_sv_test` and the production database `ogevia_prd` are two databases on **one RDS instance, `ogevia-prod-postgres`** (docs/releases/2026-10-30-caregiver-readiness/DEPLOYED_RECORD_0088_TEST.md, line 10).
- **UNKNOWN until the CloudShell check (U1):** current instance class, storage, backup retention, deletion protection, whether a second instance exists.
- `docs/aws/COST_MODEL.md` (Phase 0 estimate) lists two instances (`ogevia-postgres`, `ogevia-prod-postgres`, both db.t4g.micro). Whether `ogevia-postgres` still exists is part of U1.

## Why it matters
Separate *databases* keep rows apart, but not the server. On one instance a demo load test, a runaway query, a failed minor-version upgrade, a restore, a reboot or a mistaken instance-level change hits production too. Demo is where we run migrations first, seed data and try releases, so production shares its blast radius. Backups and point-in-time restore are per instance: restoring demo to an earlier time is not possible without touching production's timeline, and the reverse. It also blocks any auto-deploy design where a pipeline role may touch the demo database safely.

## Recommendation
Give demo its **own** small instance (`ogevia-test-postgres`, same class as today), keep production where it is, and move only the `ogevia_sv_test` database.

## Cost (estimate; no live price lookup was possible)
Using the repo's own cost model for db.t4g.micro in us-west-2: instance about $16/month + 20 GiB gp3 about $2.30 + backups about $0.50 → **about $19–20/month** more. Stop the instance when not demoing and compute drops, but storage still bills; do not rely on that. Single-AZ, no Multi-AZ, no read replica. Needs your approval as a recurring cost.

## Steps (all yellow actions: prepare now, run only after approval)
1. Before: confirm U1 output, note production's class and parameter group.
2. Take a manual snapshot of `ogevia-prod-postgres` (rollback point; no downtime).
3. Create `ogevia-test-postgres`: same VPC, DB subnet group, **private**, encrypted, new security group allowing only the admin host and the demo API Lambdas' security group, backups 7 days, deletion protection on. Same parameter group family.
4. Create the new Secrets Manager secret for it (values never printed).
5. `pg_dump` of **only** `ogevia_sv_test` through the admin host (SSM session), restore into the new instance. Synthetic/demo data only: confirm that with you first, because "test" may hold real pilot rows (UNKNOWN).
6. Re-run the verification queries (migration ledger equals 88, row counts per table match).
7. Point the **demo** API's database secret/environment at the new instance (demo stack only). Production stack untouched.
8. Smoke test on demo.ogevia.com (sign in, schedule, visit).
9. After a week of clean demo operation, drop `ogevia_sv_test` from the production instance (RED action; separate approval, with a final dump first).

## Downtime
Demo only: about 15–30 minutes during steps 5–7 (dump, restore, repoint). **Production: none.**

## Rollback
Until step 9 the old demo database still exists unchanged on the production instance. Rollback = repoint the demo secret back (minutes), then delete the new instance. Production snapshot from step 2 stays for 30 days.

## Risks
- If the demo database holds data that is not synthetic, the copy moves PHI to a second server: confirm the BAA/security posture applies equally (same account, so yes in principle, but you decide).
- Parameter or extension differences between instances: mitigated by identical family and a verification run.

## Decision needed from you
Approve (a) the ~$20/month, (b) the downtime window for demo, (c) whether `ogevia_sv_test` contains only synthetic data. Until then, no change.
