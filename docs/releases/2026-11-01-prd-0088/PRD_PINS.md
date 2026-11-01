# Production release pins, REVISION 3: WEBSITE-ONLY REPUBLISH (written 2026-11-01 21:35 UTC). Revisions 1 and 2 are superseded for the website; the database (88/0088) and API (250 routes) from revision 2 stay deployed.

**Why:** the website published at 20:27 was built against the TEST sign-in pool and was rolled back at 21:19:58Z (see `DEPLOYED_RECORD_PRD.md`). Commit below fixes the build step and adds fail-closed checks before upload and after publish.
**Owner GO (written, in conversation, 2026-11-01): "Approve web fix" and "Give GO for fb-fix commit".** Read by Claude as the GO for the single commit below (the commit that contains the web fix), on the condition that the full gates pass on it: G1 lint, G2 typecheck passed; G3 `pnpm test:all` must pass before any step starts (result recorded below when known). The owner did not state a window; **the reference and window are set by Claude**.
| Pin | Value |
|---|---|
| Approval reference | `GO-PRD-0088-R3-20261101` |
| Window (UTC) | 2026-11-01 21:45:00 to 2026-11-02 00:45:00 |
| Application commit (ONE approved commit; REPO checkout) | `be7bccfac97bfed4614fd1522486a940ee413bb1` |
| Handler / Identity code asset keys | unchanged (`9e5a510e...` / `7c5f8eb6...`): the commit changes no Lambda code |
**sha256 of the release files:**
```
0361e73330e1b45f9fb807c2f743987ea11e24aab887863d9874bea715e686d0  STELLA_PRD_DB.sh
d3290272069045950ac5daf4d302f1624de7b232df0dd5a68126a9fb8b1bac40  STELLA_PRD_DEPLOY.sh
05db104472a7934eec695eb7b026d3179de9ab4a9581ff7001a1854b726f9830  STELLA_PRD_READONLY.sql
e905e7b751e0998d5c240be58fd39710fbe411991321d014e47ddb97c80b7a26  diff_gate_prd0088.py
```
**Steps (website only; do NOT run `probe`, `snapshot`, `migrate`, `capture`, `check`, `deploy-api`):** local setup and selftests; refresh the database marker for the new commit (the database is unchanged since the 20:13 `final`); `web` (typed `PUBLISH-WEB-PRD`) which runs the new pre-upload bundle check and then `web-verify` with the new production-pool assertions; the owner's sign-in checks. `capture` is not rerun because the API and Lambda intentionally differ from the pre-release baseline now. Rollback: `rollback-web` restores the saved pre-release files (still in `~/prd0088-before`).

# Production release pins, REVISION 2 (written 2026-11-01 19:26 UTC). Revision 1 (commit f117510, ref GO-PRD-0088-20261101) is SUPERSEDED: do not use its files or `a3a5125`.

**What happened:** with revision 1, P1 to P4 passed (database migrated to 88/0088 at 18:57:18Z, verified). P5 (`deploy-api`) failed at 19:02Z: API Gateway refused the duplicated `https://app.ogevia.com` in `AllowOrigins` (HTTP 400). CloudFormation rolled back: stack `UPDATE_ROLLBACK_COMPLETE`, Lambda code equals the original (`E4Vv7ush...`), 228 routes (VERIFIED from the operator's output). Production API and website are unchanged; the database is at 88.
**Owner decision (written, in conversation, 2026-11-01): "Approve the dedupe fix, full gates, new GO".** Treated as the written GO for the single commit below, on the condition (met) that the full gates pass on it: G1 lint, G2 typecheck and G3 `pnpm test:all` (23 files, 158 tests, none skipped, all passed; scratch local database). The fix is one line in `service-verification-api-stack.ts` (duplicates removed from the API CORS origins), one new test, one fixture offset; the migrations and all other application code are identical to f117510 (VERIFIED by `git diff`).
**Set by Claude (change by re-filling):** reference `GO-PRD-0088-R2-20261101`; window 2026-11-01 19:30:00 to 22:30:00 UTC.
**Remaining steps (database already done; do NOT rerun `probe`, `snapshot` or `migrate`):** P1 `synth`, `capture`, `check`; marker refresh (below); P5 `deploy-api`; P6 `web`; P7 `smoke` and the owner's checks; P8 `final`. The 2026-11-01 17:03 snapshot remains the restore anchor.
**Marker:** `~/.prd0088/db-at-0088.ok` holds the old commit. The migrations are unchanged (VERIFIED), so after a read-only `STELLA_PRD_DB.sh final` shows ledger 88/0088, the Operator rewrites the marker with the new commit (command in the hand-off), as the deploy script requires.

| Pin | Value |
|---|---|
| Approval reference | `GO-PRD-0088-R2-20261101` |
| Window (UTC) | 2026-11-01 19:30:00 to 2026-11-01 22:30:00 |
| Application commit (the ONE approved commit; REPO checkout) | `fb8b7aa4eb73c0cfe4dd6f718930ea54e318cfd7` |
| Application code vs f117510 | one line in the API stack plus tests; migrations and everything else identical |
| Handler / Identity code asset keys | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7` / `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759` (from a local synth at the dry-run commit; the release-night `synth` must reproduce them or it stops) |
| Migration pins (0088; all-88 set; 0086-0088 rollback set) | `dc20f327794a6f9b6e4f79d201550f1d0a9970e2e4b800c27b598213c82cf34f`; `049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c`; `4b53cb1908a5939bb3aac47ca0725b16d264690d2d83f78e4cca7cae4d035d05` |

**sha256 of the release files (verify before running; they are in this folder at the branch tip):**
```
0beb61de2082fc9a08b613d9b883c36d2a6a7deeb2048c13f172788192b2f5d6  STELLA_PRD_DB.sh
6ad233418b8cffb007a838faada13e42ea841af45702007a34a28401786308e3  STELLA_PRD_DEPLOY.sh
05db104472a7934eec695eb7b026d3179de9ab4a9581ff7001a1854b726f9830  STELLA_PRD_READONLY.sql
e905e7b751e0998d5c240be58fd39710fbe411991321d014e47ddb97c80b7a26  diff_gate_prd0088.py
```
The gate and the SQL are byte-identical to the dry-run copies (VERIFIED by `cmp`). The scripts' commit is later than the application commit; it contains only the filled scripts and documents. Nothing is deployed until the Operator runs the steps of `PRD_RUNBOOK.md` part 3; each mutating step also needs its typed phrase. The sequence stops at the first failed check; rollback is the owner's decision (web, then API, then database).

**Revision 2a (2026-11-01 20:00 UTC):** `capture` stopped at 19:54Z because the script accepted only `UPDATE_COMPLETE` for the API stack, which is `UPDATE_ROLLBACK_COMPLETE` after the rolled-back deploy (everything else matched the baseline). `STELLA_PRD_DEPLOY.sh` now also accepts `UPDATE_ROLLBACK_COMPLETE` for the API stack only, in `capture` and in the gate; the live template is still compared with the baseline, any other stack in that state is refused, and the post-deploy check still requires `UPDATE_COMPLETE`. Mock test: 2 new checks pass. The application commit, reference and window are unchanged. Superseded deploy-script hash: `97e91a74...`.

**Revision 2b (2026-11-01 20:15 UTC):** `STELLA_PRD_DB.sh final` stopped at 20:04Z with "stack ... UPDATE_ROLLBACK_COMPLETE, not a settled status" (before any change; no window opened): the database script had the same status rule. It now also accepts `UPDATE_ROLLBACK_COMPLETE`; the environment guard (Lambda must serve ogevia_prd with OGEVIA_ENV=prd) is unchanged, and `UPDATE_FAILED` is still refused (mock test: 2 new checks, all pass). Superseded database-script hash: `57b4644c...`.
