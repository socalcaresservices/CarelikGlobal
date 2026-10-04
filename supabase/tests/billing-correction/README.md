# Production defect: correcting a billing-approved visit (reproduction)

**Finding (2026-10-04).** In the production Supabase build, `correct_service_visit` never checks `billing_approvals`. The failure path:

1. A manager approves a visit (120 min).
2. A manager corrects the visit. The old row becomes `corrected`, and the new row is `signed`.
3. The first approval stays **active** on the replaced row.
4. `list_billing_ready_visits` lists the new row as Billing Ready again.
5. The new row is approved again (90 min). The unique index is per row, so it allows this.
6. The owner submits both approvals: **210 minutes submitted for one 90-minute visit.**

**Evidence:**
- `run.sh` loads the shared stub schema from `../service-verification` and the **real** production function bodies, extracted verbatim from the migrations by `extract.py`. It then runs `scenario.sql`, which exits 0 only if every step above happens.
- On 2026-10-04 the live production function bodies were compared read-only by md5 against these migration texts: `correct_service_visit`, `approve_visit_for_billing`, `submit_billing_approvals` and `list_billing_ready_visits` are **identical**.
- Live production (read-only, counts only) has 0 billing approvals and 0 visit corrections, so the defect has not caused a double submission yet.

**Proposed fix (not applied):** `supabase/proposed/20261004120000_block_correction_of_billing_approved_visits.sql`, a status guard trigger, which is the same rule as AWS migration 0019. `verify_fix.sql` shows:
- the correction of an approved visit is refused and leaves nothing behind;
- after `void_billing_approval`, the correction applies.

**Every write path and concurrent sessions** (also run by `run.sh`, with the fix loaded):
- The bodies of all 11 production functions involved are checked against live production (md5, read-only, 2026-10-04) before any test runs; a mismatch stops the run.
- `all_paths.sql`: on one approved visit, each path is tried as the role that may normally use it. That covers all 7 production functions that update `service_visits`, a second approval, a direct status update by a role that bypasses RLS, and direct UPDATE/DELETE as `authenticated` (with production's SELECT-only RLS policies). All 14 are refused with their specific message; the visit row, its approval and the visit count are unchanged.
- `concurrency.sh`: two real sessions on the same visit (correction vs approval in both orders, two approvals, a void in progress vs a correction, two corrections). Each waits for the other's row lock where one exists, and the final state is checked exactly.
- Control: with the fix not loaded, the same tests fail (the correction of an approved visit goes through; concurrent cases C2 and C4 fail).
- Residual, outside application paths: a role that bypasses RLS (`service_role`, `postgres`) can still change minutes on an approved visit without changing its status.

Results: `EVIDENCE-2026-10-04.txt` section 4.

Applying it to production is a separate change that needs owner approval.

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres bash supabase/tests/billing-correction/run.sh
```
