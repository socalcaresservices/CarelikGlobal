# Security review: migration 0086 and the new API routes (release 2026-10-30-caregiver-readiness)

**Status: FILED FOR REVIEW. NOT REVIEWED.** Every reviewer verdict box below is empty on purpose. The "author evidence" columns are Claude Code's statements and measurements; the reviewer must check them, not rely on them. Required by `docs/security-review-checklist.md` (any new or changed `SECURITY DEFINER` function, RLS policy, grant or revoke) and by the release checklist (Phase A, "Migration touches SECURITY DEFINER, grants or tenant access").

| Field | Value |
|---|---|
| Code under review | commit `54894411f0e69ac29bec762006e47f7d943b94f2` on `claude/practical-tesla-r07odb` (migration unchanged since `dd59c8b`) |
| Migration / rollback | `infra/aws/db/migrations/0086_caregiver_readiness_approve_for_work.sql` / `infra/aws/db/rollback/0086_caregiver_readiness_approve_for_work.down.sql` |
| API code | `apps/sv-api/src/routes.ts` (8 new routes; the D1 fix `withClientNames` keeps `Date` values) |
| Web | not security-relevant beyond showing server answers (no eligibility rule lives in the browser) |
| Reviewer (full name, role) | ______________________________ |
| Review started / finished | ______ / ______ |

**How the repo checklist maps to this stack.** It was written for Supabase (`auth.uid()`, `public`). Here the identity is established by `ogevia_api.begin_request(<cognito sub>)` (the API calls it first in every transaction, as role `ogevia_app`); the actor is read with `ogevia.require_actor()`; membership by `ogevia.is_active_member(org)`; permissions by `ogevia.has_permission(org, key)`; the API schema is `ogevia_api`, internal helpers are `ogevia`. `ogevia_app` has **no table privileges** (only EXECUTE on `ogevia_api` functions), so a `SECURITY DEFINER` function is the only way to touch data. `anon` does not exist in this stack: nothing in 0086 is callable without a signed-in Cognito identity.

## How the facts below were obtained (reproduce them)
Migrate a scratch local database to 0086 (`OGEVIA_DATABASE_URL=postgres://…/scratch pnpm --filter @carelik/infra-aws db:migrate`) and run:
```sql
-- function mode, pinned search_path, EXECUTE grants
select n.nspname||'.'||p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('public', p.oid,'execute') pub, has_function_privilege('ogevia_app', p.oid,'execute') app, has_function_privilege('ogevia_readonly', p.oid,'execute') ro
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('ogevia','ogevia_api') and p.proname in (<names in section 1>);
-- tables: RLS, privileges, policies
select c.relname, c.relrowsecurity, has_table_privilege('ogevia_app',c.oid,'select') app_sel, has_table_privilege('ogevia_readonly',c.oid,'select') ro_sel,
       (select string_agg(polname||' using '||coalesce(pg_get_expr(polqual,polrelid),'-'),';') from pg_policy where polrelid=c.oid) policies
from pg_class c where c.relname in ('organization_compliance_settings','caregiver_cpr_tb_extensions','caregiver_work_approvals','caregiver_contacts');
```
Measured on 2026-10-30 against a fresh database at 86 migrations.

## 1. Checklist A: every new or modified `SECURITY DEFINER` function
Measured for all 13 `ogevia_api` functions: **`SECURITY DEFINER`, `search_path = ogevia, pg_temp`, EXECUTE revoked from PUBLIC and granted to `ogevia_app` only, not to `ogevia_readonly`.** For each, the reviewer ticks the five checklist questions.

Legend: **Tenant** = does it validate that the target row belongs to the organization the caller claims? **Relationship** = the specific permission/relationship it implies, not just membership. **Search path** and **Grants** are the measured facts above. **Client-supplied ids** = does it trust a client-supplied organization/user id for more than a row to re-validate?

| # | Function (new / modified) | Tenant check (author evidence) | Permission and relationship (author evidence) | Test that covers a refusal | Client-supplied ids (author evidence) | Reviewer: T / R / S / G / C |
|---|---|---|---|---|---|---|
| 1 | `get_caregiver_readiness` (new) | `compliance_read_guard(org)` (active member of `org`), then the record is read with `id = rec and organization_id = org and deleted_at is null`; other agency's id returns 404 | read permission: `readiness.read` or `caregivers.manage` or `caregivers.compliance.manage` | DB "tenant isolation and permissions"; API "reads need a signed-in office user …" (403 caregiver, 404 other agency) | `p_organization_id` is re-validated against the actor's membership; actor comes from `begin_request` | ☐ ☐ ☐ ☐ ☐ |
| 2 | `approve_caregiver_for_work` (new) | `caregiver_admin_guard(org)`; record locked and read with `organization_id = org`; approval row inserted with the same org (FK `(caregiver_record_id, organization_id)`) | `caregivers.manage`; refuses unless every hard requirement is met (re-computed in the database, not taken from the client); one approval per caregiver (unique) | DB "approval is blocked …" (4 tests), "a concurrent double-click …"; API approve 409/403/404 | as row 1; the client never sends eligibility or status | ☐ ☐ ☐ ☐ ☐ |
| 3 | `extend_cpr_tb_due_date` (new) | membership check on `org`; record read with `organization_id = org`; extension row carries `org` (FK) | `caregivers.compliance.manage` (administrator) only; requirement limited to cpr/tb; reason required; date must exceed the current due date and be within a year | DB "extensions: …" (manager 403, other agency 404); API extend (403/404/422) | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 4 | `list_cpr_tb_extensions` (new) | `compliance_read_guard(org)`; rows filtered `organization_id = org and caregiver_record_id = rec` | read guard | API "history lists it"; cross-agency via the guard | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 5 | `get_compliance_settings` (new) | `compliance_read_guard(org)`; reads the setting of `org` only | read guard | API "settings: … another agency gets 404" | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 6 | `set_cpr_tb_due_days` (new) | membership check on `org`; upsert keyed by `org` | `caregivers.compliance.manage`; 0 to 365; reason required; audited | DB "the agency setting …"; API settings (403/404/422) | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 7 | `set_caregiver_contact` (new) | `caregiver_admin_guard(org)`; the record must exist with `organization_id = org` before the upsert; `caregiver_contacts` has the same composite FK | `caregivers.manage`; email validated; audit stores only booleans (no value) | DB "a contact can be saved by Care Team managers …" (caregiver 403, other agency 404); API contact | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 8 | `get_signin_contact` (new) | `caregiver_admin_guard(org)`; join `r.id = rec and r.organization_id = org`; returns the stored email or the invitation address **to the API server only** | `caregivers.manage`; the route never returns the value (tests assert it is absent from every response, list, audit row and log) | DB "…never in a list, an audit row …"; API "the full path over HTTP" | as row 1 | ☐ ☐ ☐ ☐ ☐ |
| 9 | `list_caregivers` (modified: adds calculated status, readiness counts, has-contact boolean) | unchanged guard (`visits.read` and membership) and `cr.organization_id = org`; new helper calls use `cr.organization_id` (the row's own org) | unchanged; returns **booleans and counts, not contact values** | DB "the detail summary, the Caregivers list and the Staff list agree …"; "never in a list" | unchanged | ☐ ☐ ☐ ☐ ☐ |
| 10 | `list_accounts` (modified: adds work status, readiness counts, has-contact) | unchanged `accounts_manage_guard(org)` and `m.organization_id = org` | unchanged (organization owner) | same as row 9; accounts tests | unchanged | ☐ ☐ ☐ ☐ ☐ |
| 11 | `set_caregiver_status` (modified: refuses `ready`/`active`) | unchanged guard and org-scoped row | **stricter**: Approved/Active can no longer be set here; only Approve for work | DB `caregiver-gate-no-service`, `invitations-planned` | unchanged | ☐ ☐ ☐ ☐ ☐ |
| 12 | `begin_invitation_resend` (modified: rate limit) | unchanged guard; invitation read with org and record; the 24-hour count reads `audit_events` filtered by `organization_id` and entity | `caregivers.manage`; 60 s gap and 5 a day | DB "resend is limited …"; API "tooSoon" 409 | unchanged | ☐ ☐ ☐ ☐ ☐ |
| 13 | `get_compliance_summary` (modified: agency due days in the text) | unchanged guard and org-scoped aggregates | unchanged | existing compliance tests | unchanged | ☐ ☐ ☐ ☐ ☐ |

Internal (`ogevia.*`) functions changed or added: `caregiver_readiness`, `caregiver_readiness_summary`, `caregiver_work_status`, `caregiver_has_signed_in`, `caregiver_has_contact`, `compliance_grace_for`, `compliance_grace` (same signature as before), `compliance_grace_days` (two forms), `compliance_blockers`, `compliance_snapshot`, `readiness_checks` (the single gate for every assignment path), `ensure_onboarding_defaults`, `append_only_guard`. Measured: **all are `invoker` with `search_path = ogevia, pg_temp` and no EXECUTE for PUBLIC, `ogevia_app` or `ogevia_readonly`**, so they are reachable only from inside the definer functions above. Each takes `p_organization_id` and filters every table read by it. Reviewer: ☐ confirm that no internal function is callable from the API role directly (re-run the grants query above), ☐ confirm `readiness_checks` still enforces every context it did (assignment, pickup, series, visit start): see the unchanged gates exercised by `compliance-hold.db.test.ts` and `cpr-tb-verified-required.db.test.ts`.

## 2. Checklist B: tables, RLS, grants
Measured (fresh database, 86 migrations):

| Table | RLS | `ogevia_app` privileges | `ogevia_readonly` | Policies | Notes for the reviewer |
|---|---|---|---|---|---|
| `caregiver_contacts` (email, phone) | **on** | **none** (no select, no write) | **none** | **none** (RLS on with no policy = no row visible to anyone except the owner role) | The only restricted-PII table in this release. The **values** are read only by functions 7 and 8; the internal helper `ogevia.caregiver_has_contact` also reads the table but returns **only a yes/no boolean** (used by the readiness function and the two lists). ☐ confirm no other function selects the email or phone values (`grep -n caregiver_contacts` in the migrations) |
| `caregiver_work_approvals` | on | none | `select` | `readonly_select using (true)` | Append-only trigger (update/delete refused). Holds the requirement snapshot (statuses, labels, dates; no contact data) |
| `caregiver_cpr_tb_extensions` | on | none | `select` | `readonly_select using (true)` | Append-only trigger. Free-text `reason` (3 to 500 characters) is visible to the read-only role |
| `organization_compliance_settings` | on | none | `select` | `readonly_select using (true)` | One integer per agency |

Checklist B questions for the three tables with a policy: ☐ **Does the policy reference the row's own `organization_id`?** No: `readonly_select … using (true)` returns every tenant's rows to `ogevia_readonly`. **This is the established pattern**: the same-named policy `readonly_select` exists on 90 tables of the schema including these three (measured), and the role is the operator's read-only verification role, not an application role. Reviewer must confirm that `ogevia_readonly` is never given to the API or any customer-facing path. ☐ **Is there already a permissive policy for this role/action?** No: one policy per table, created in this migration. Two older tables (`permissions`, `role_permissions`) have no RLS; they are reference tables and are not touched.

## 3. Release-specific items (not in the repo checklist)
| # | Item | Author evidence | Reviewer |
|---|---|---|---|
| S1 | Contact PII stays server-side | `caregiver_contacts` unreadable by every role; lists return booleans; the sign-in route returns only the invitation record, never the address; tests assert the address is absent from responses, audit rows and the handler's log records | ☐ |
| S2 | Audit never holds contact values | `caregiver.contact_set` stores `{"email_set": true, "phone_set": false}`; test checks the address and phone are absent | ☐ |
| S3 | Eligibility is decided on the server | The browser sends no status, balance or eligibility; approval re-computes the hard requirements inside `approve_caregiver_for_work`; direct API calls are refused (tests) | ☐ |
| S4 | Double submit / retry | Row lock (`lock_caregiver`) + unique approval row + idempotency keys on approve, extend, settings, contact; 3 parallel approvals produce one row and one audit entry (test) | ☐ |
| S5 | Administrator-only actions | Extension and the due-days setting require `caregivers.compliance.manage` (organization owner); a manager is refused (tests) | ☐ |
| S6 | Append-only history | Update and delete on approvals and extensions raise `OGC09` (tests) | ☐ |
| S7 | Sign-in link abuse | One a minute and five a day per caregiver (counted from the audit trail), none after first sign-in; the password is generated and mailed by Cognito and never passes through Ogevia | ☐ |
| S8 | No new unauthenticated surface | All 8 routes are behind the existing authorizer; none is added to the public route set (`slice-contract` test); no `anon` role exists | ☐ |
| S9 | Backfill and data changes | One `legacy_status` approval per existing Ready/Active caregiver (no approver); three onboarding requirement categories set inactive; nothing deleted; rollback documented (BACKUP REQUIRED) | ☐ |
| S10 | Logs | No new logging of request bodies; the handler's log records carry no email or name (test asserts the invited address is absent from the log) | ☐ |
| S11 | The D1 fix | `withClientNames` returns `Date` values unchanged; it adds names only where a `clientCode`/`clientId` is present, exactly as before; unit tests cover Dates, nesting, names and non-mutation | ☐ |

## 4. Points the author asks the reviewer to look at hardest
1. **`readonly_select using (true)`** on the three new tables (section 2): consistent with the schema, but it exposes the free-text extension reason across tenants to the read-only role.
2. **Approve requires `caregivers.manage`** (managers can approve), while extension requires the administrator. This mirrors the old status change (`set_caregiver_status` used `caregivers.manage`); the owner has not yet confirmed it (README decision 2).
3. **Background clearance is verified by the administrator only** (unchanged); approval depends on it, so a manager cannot approve around it. Reviewer: confirm there is no path that sets a verified result without `caregivers.compliance.manage`.
4. **Email is stored as plain text** in an RDS column (encrypted at rest with the instance, no field-level encryption). Confirm this is acceptable for the PHI/PII classification of a caregiver's work email.
5. **The rate limit reads `audit_events`.** If audit rows are ever archived, the 24-hour count would reset; it only ever errs towards allowing a resend, never towards exposing data.
6. **`readiness_checks` was redefined** (CPR/TB now pending inside the due date, reversing the 0081 rule by owner decision). It remains the single commit-time gate; confirm no assignment path lost it.

## 5. Not reviewed here / limits
Cognito configuration and invitation email content, the API authorizer and IAM policies (unchanged by this release), the infrastructure diff (the real `cdk diff` is the Operator's, after the owner's GO), the web bundle beyond "no rule in the browser", and any live data. Evidence is from a fresh local database and the automated suites; nothing was run against any shared environment.

## 6. Reviewer findings
| # | Section / item | Finding | Severity (Blocker / Major / Minor) | Status |
|---|---|---|---|---|
| | | | | |

## 7. Sign-off
| Field | Entry |
|---|---|
| Outcome | ☐ **APPROVED** (every box ticked, or a written justification below) ☐ **CHANGES REQUESTED** ☐ **REJECTED** |
| Justifications for any box not ticked | |
| Reviewer signature | ______________________________ |
| Date | ______________________________ |

Per `docs/security-review-checklist.md`: do not approve without checking every box or giving an explicit written justification for why a box does not apply. Until this is signed, the release checklist item "security review" stays **OPEN**.
