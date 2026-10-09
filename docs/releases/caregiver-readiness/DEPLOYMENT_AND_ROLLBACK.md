# Deployment order and data-preserving rollback (PROPOSED: nothing here has been run against AWS)

## Order
1. **Migrations 0039 -> 0043** (`pnpm --filter @carelik/infra-aws db:migrate`, the repository runner; checksummed, one transaction each).
   All are additive. Behaviour change on migrate: `replace_my_availability` now refuses; candidate lists require approved availability (care requests already did);
   `check_shift_caregiver` etc. call the gate but every agency is **report-only**, so no existing commitment is stranded.
   Run `db/verification/*` afterwards (updated for the new objects; read-only role has SELECT on the new tables except the two ZIP tables).
2. **API/routes:** CDK adds 36 routes behind the existing JWT authorizer (no public route added). The route list is asserted identical to the handler's
   by `slice-contract.test.ts`; the single-permission Lambda policy keeps the resource policy small. Deploying requires the owner's approval (CLAUDE.md yellow action).
   Deploy the API **after** the migrations: new routes call new functions. Old web builds keep working except the old availability save, which now returns a clear 422.
3. **Web build** last. It needs the new permission keys, which the database already returns from `/v1/me`.
4. **Then, deliberately and separately (owner):** set CPR/TB document types and rules -> collect availability/approvals -> review report -> activate -> (later) Service checks On.

Cutover dependencies: none on Cognito, S3 or hosting. Dependency on PR #75 being merged first.

## Rollback (each `rollback/00NN_*.down.sql`, newest first: 0043 -> 0039)
Class SAFE AUTOMATED. **Nothing that holds data is dropped.** Each script first copies every populated table to `ogevia.archived_<table>_00NN_<timestamp>`
(count-checked; it aborts if a copy is incomplete), restores each replaced function to its exact previous definition, then removes the new objects.
0039 additionally rewrites today's approved hours and approved future exceptions as plain legacy rows so matching keeps working. Re-applying the release
afterwards works and starts clean. Proven by `readiness-rollback.db.test.ts` (populated database, down 0043->0039, archives checked, old behaviour checked,
re-up checked) and `availability-rollback.db.test.ts`. A web/API rollback is a redeploy of the previous build; it needs no data change.
Not restorable by rollback: audit rows written during the release (they only grow, by design).
