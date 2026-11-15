# Production database record: manual changes of 2026-11-14 (Pacific) / 2026-11-15 (UTC)

**Status: DEPLOYED BY HAND, owner-reported. NOT in any migration. Effect on the user-facing 500s is NOT yet confirmed by evidence.**
Database `ogevia_prd` on `ogevia-prod-postgres`, connected through the admin host with an SSM port-forward and the RDS master user, inside a temporary `/32` security-group rule. This record corrects the earlier working notes in this session: the second change is a **GRANT EXECUTE**, not an ownership change.

## Why
After the UX release, `GET /v1/notifications` and `GET /v1/attention` returned 500 (SQLSTATE `42501`, permission denied) and the scheduled compliance sweep failed with `permission denied for table business_documents` in `ogevia_api.system_compliance_orgs()`.
Cause found: migration 0093 (applied to production under the migration admin login) left `ogevia.business_documents` owned by `ogevia_admin` with RLS on, no policy and no grants. Migration 0100 then made two functions that run as `ogevia_owner` read it. Migration 0100 also created a wrapper `ogevia.action_issue_rows` owned by `ogevia_admin` and ran `revoke all … from public` on it, so `ogevia_owner` (the role the notification and attention functions run as) could not execute it.

## Change 1: read access to `business_documents` for the function owner
| | |
|---|---|
| Statements (one transaction, committed) | `set local role ogevia_admin; grant select on ogevia.business_documents to ogevia_owner; drop policy if exists owner_definer_select on ogevia.business_documents; create policy owner_definer_select on ogevia.business_documents for select to ogevia_owner using (true);` |
| Evidence | Owner pasted the closing `reset role; commit; COMMIT`. Afterwards `set role ogevia_app; select count(*) from ogevia_api.system_compliance_orgs();` returned `1` (it raised `permission denied` before). The opening statements and their output were not pasted. |
| Time | Not recorded. After the first error log line (2026-11-15T00:59Z) and before the owner's next log read (2026-11-15T03:03Z). Exact time is in the RDS/CloudTrail record of that session. |
| Scope of the policy | `ogevia_owner` only (the role that already reads every tenant table as owner). `ogevia_app` and signed-in users gain nothing; each function still filters by organization. |
| Rollback | `begin; set local role ogevia_admin; drop policy if exists owner_definer_select on ogevia.business_documents; revoke select on ogevia.business_documents from ogevia_owner; reset role; commit;` Rolling back re-breaks `system_compliance_orgs()`. |

## Change 2: execute access to `action_issue_rows` for the function owner
| | |
|---|---|
| Statement (committed, owner-reported) | `grant execute on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) to ogevia_owner;` |
| Ownership | **Unchanged.** The function is still owned by `ogevia_admin`. Before the grant its ACL was `{ogevia_admin=X/ogevia_admin}` and `has_function_privilege('ogevia_owner', …)` was `false` (read-only check, 2026-11-15). |
| Evidence | The owner states it committed successfully. The statement output was not pasted here. |
| Rollback | `revoke execute on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) from ogevia_owner;` Rolling back re-breaks notifications and attention. |

## Still to confirm (UNKNOWN today)
1. `notifications` and `attention` return 200 in production. No post-grant evidence has been pasted. The 500 log lines read at 03:03–03:11Z may predate the grant.
2. The RDS security group has only its original rule (`sgr-088d9ee71c4b0244d`, source `sg-064ffce3bcbe8eb3b`). The first window (`TEMP-prd-grant-fix`) was verified closed; the second (`TEMP-prd-grant-fix2`) has no recorded closing.

## Follow-ups (not part of this release)
- Put both changes into a numbered migration for TEST and any rebuild, with its rollback, or document them as production-only drift with an owner decision. A database rebuilt from the repository will not have them.
- `ogevia_admin` still owns 4 tables (`business_document_files`, `business_documents`, `client_qr_cards`, `missing_visit_reason_labels`) and 17 functions in production (including `start_service_visit`, `client_qr_checkin`). A planned ownership clean-up, with its own approval and rollback, would remove this class of defect. Not proposed as an emergency change.
