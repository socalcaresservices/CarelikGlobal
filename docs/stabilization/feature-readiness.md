# Phase 6 — Features built but not deployed: readiness

Date: 2026-11-23 · Branch `stabilization/main-reconciliation` · STATUS: **COMPLETE (assessment); decisions below NEED HUMAN INPUT**

Evidence tags: VERIFIED = run or read in this session; INFERRED = from code/records; UNKNOWN = needs a live read or an owner decision.
No production or TEST change was made. Re-run today (local Postgres): `bulk-import-0092.db.test.ts` 10/10, `staff-duplicates-0093.db.test.ts` 5/5, `apps/sv-api` `bulk-import.db.test.ts` 6/6, web `import-drawer`, `staff-duplicates`, `names-duplicates`, `staff-bulk-invite`, `care-links` suites 42/42 (VERIFIED).

## Summary

| Feature | Where it is | Decision |
|---|---|---|
| Bulk import (people, clients; CSV) | DB functions already in the migration set (0105, so in the production ledger — VERIFIED from repo; confirm with the live ledger read). Routes `POST /v1/imports/{kind}` behind `bulkImport`: **ON in TEST (`config.ts` line 256), OFF in production** (line 296). | **FIX FIRST** (3 items) |
| Duplicate staff report and merge | DB functions in the migration set (0106). Routes `GET /v1/staff/duplicates`, `POST /v1/staff/{profileId}/merge` behind `staffDuplicates`: **OFF in TEST and production**. | **DO NOT ENABLE** until the report has been reviewed on TEST (report-only first) |
| Save-to-phone help (public care request page) | Only commit `1bd7f28a` on `claude/peaceful-clarke-uw8l1h`; not in production, not in `main`, **not in this branch** (deliberately not merged in Phase 2). Front-end only; no data, no migration, no switch. | **ENABLE after merge** (clean merge computed in Phase 1) and a real-phone check |

## 1. Bulk import

What it does (VERIFIED, code + migration header): preview writes nothing; confirm is one transaction; the tenant comes from the session, never the file; rows are created through the existing `create_caregiver` / `create_staff` / `create_client` functions (so client codes, ids and audit apply); the same file hash twice creates nothing (`import_batches`, unique per org+kind+hash, append-only, RLS); duplicates are skipped, never merged; no invitation or sign-in is created; one audit event holds the hash and counts only; 2,000-row and 2 MB limits.

Tests (VERIFIED): 10 DB tests (1,000-row file in one call, 2,001 refused, idempotency, atomicity); 6 API tests (preview vs confirm, XLSX and renamed archives refused, malformed 422, invalid rows block confirm, caregiver 403 / unauthenticated 401 / other agency 404, no file content or names in logs); web `import-drawer` tests.

Security: tenant isolation and role checks tested at API level; imports carry client data (PHI) so the production run must be a deliberate, small first file. Blast radius of an error is bounded: rows are created (not overwritten), and an import is all-or-nothing.

Rollback: switch off (routes disappear). Created records remain; they are ordinary clients/staff and are closed with the normal deactivate actions, not deleted (INFERRED: no bulk-delete exists, by design). Rollback SQL `0092_bulk_import.down.sql` exists in `db/pending/rollback` but would drop the batch table; it must not be used once production has imported anything.

FIX FIRST:
1. **TEST end-to-end pass is not on record.** The switch is on in TEST, but I found no recorded TEST run of an import (UNKNOWN). Owner or I (with a CloudShell block) run one synthetic, non-PHI CSV: preview → confirm → re-upload (creates nothing) and attach the output.
2. **Scope gap against R11:** the requirement says CSV/XLSX and Excel templates; the API **refuses XLSX** by design (test "refuses XLSX and renamed archives"). Decide: CSV only (change the requirement wording) or build XLSX parsing (new dependency + zip-bomb guard). Recommendation: CSV only.
3. **Stale record:** `db/pending/README.md` still lists 0105/0106 as "pending, not part of any release" although the files are in `db/migrations`. Correct the README (it misleads release reviewers).
Then: ENABLE `bulkImport` in production by the existing two-step route release (code-only already deployed; routes-only change set), with the owner's explicit approval.

## 2. Duplicate staff merge

What it does (VERIFIED, 0106 header + tests): `list_possible_duplicate_staff` is read-only (same email, phone digits ≥7, or full name). `merge_staff_profiles` marks the extra staff profile inactive and linked (`staff_merge_links`, append-only, RLS), requires a reason (5–500 chars) and audit event, refuses unless there is a hard match, refuses a duplicate that has a sign-in or pending invitation, never deletes, and is reversible by setting the profile active again. Caregiver records are not merged (they carry schedule and visit history).

Tests (VERIFIED): 5 DB tests; web `staff-duplicates`, `names-duplicates`; switch test (routes absent when off, JWT required when on).

Why not enable: it is the only one of the three that changes existing records, and it has never been exercised on TEST (switch OFF there; UNKNOWN otherwise). A wrong merge hides a real person's profile from Staff (reversible, but it affects who can be invited/assigned).
Path: (1) turn `staffDuplicates` on in TEST only, run the read-only report against real TEST data and review the groups; (2) do one merge in TEST and one reversal; (3) only then request production approval. Report-only exposure (no merge button) would be a safe first production step but is not built as a separate switch; I recommend not adding one.
Rollback: switch off; `staff_merge_links` rows stay (append-only); reactivate a merged profile in Staff.

## 3. Save-to-phone help

Commit `1bd7f28a` (+44 lines in `care-public-pages.tsx`, +10 in `care-links.test.tsx`; author note in the commit: "Not tested on real devices; no QR code or manifest yet"). Adds a card with iPhone/Android "Add to Home Screen" steps, an optional shortcut nickname (sets `document.title`), and a Copy link button using the Clipboard API with a failure message.
Security (INFERRED from the diff): no network call, no storage, nothing logged. The copied link is the page URL including the access token in the URL fragment; the card itself warns "Keep this link private". The nickname is local. Residual: clipboard copy of a tokenized link is the user's own action.
Blockers: none technical. Open: not checked on a real iPhone/Android; no QR/manifest (not requested). Because the commit predates the release lineage, merging it will change application files and force a release re-pin (two-commit pattern) and a normal TEST → production web release; it cannot be "switched on" separately.
Decision: ENABLE (ship in the next web release) after merging the branch and a real-phone check; do not merge it into the reconciliation branch unless the owner wants it in the same release.
