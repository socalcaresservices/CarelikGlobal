# Migration status matrix: TEST and production, 0086 and 0087

Written 2026-10-28 for candidate code `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`). **Nothing here has been run against AWS by the development session** (no AWS access). Labels: **VERIFIED** = read from a committed record of output the Owner/Operator pasted, or read from the repository; **ASSUMED** = follows from the records but was not re-read; **NOT VERIFIED** = unknown. No state below was read live today.

## 1. Where each environment is

| | TEST (`ogevia_sv_test`, API `s0epy5rgzb`, web `demo.ogevia.com`) | Production (`ogevia_prd`, API `zk527zk4ua`, web `app.`/`admin.ogevia.com`) |
|---|---|---|
| **Is 0086 applied?** | **YES.** VERIFIED as of 2026-10-26 (04:57Z) by the Operator's pasted output (`DEPLOYED_RECORD_TEST.md`: `0086 applied (2 tables, 21 functions)... verify-0086.sql 110 PASS`, and the final read `1|1|21` at Step 15). The file applied is the one in this repository: `8eb7b4a353300ba7…` (the 7870a04 package pinned the same hash). **Not re-read since**; ASSUMED unchanged (nothing in the records applied or rolled back anything to TEST's database after 2026-10-26 except read-only V4 checks). | **NO, but NOT DIRECTLY OBSERVED.** The only production read (the Owner's read-only discovery, 2026-10-26) saw the **ledger** (85 / 0085). 0086 is applied *outside* the ledger, so the ledger cannot show it. That it is absent is INFERRED: no production package has ever been run (`PRODUCTION_RELEASE_PREPARATION.md`), and 0086 sits in `db/pending`, which no earlier release package carried. **The first real reading will be Step 6 of the production procedure** (`staff-management objects… 0|0|0` and `0087 objects… 0`), before any change. |
| **Is 0087 applied?** | **NO.** 0087 was written on 2026-10-28; nothing has applied it anywhere (VERIFIED: it is only in the repository; no deployed record mentions it). | **NO** (same reason). |
| **Migration ledger** | 85 migrations, latest `0085`. VERIFIED 2026-10-26 (Step 15 record). | 85 migrations, latest `0085`, applied 2026-10-20. VERIFIED 2026-10-26 (discovery capture). |
| **Objects (staff_types | staff_profiles | functions of 21 / functions of 2)** | `1|1|21` / `0` (ASSUMED from the 2026-10-26 reading) | `0|0|0` / `0` (INFERRED; Step 6 reads it) |
| **Code that runs** | web and API at `7870a04` (Handler `94b73574c5a6…`, 241 routes). VERIFIED by the deployed record. Whether the web was since republished with `24fd8b1` (verification steps T3-T5 of `TEST_CANDIDATE_VERIFICATION.md`): **NOT RUN** in the records. | Web label `e80b770`, Lambda `debd1d43…`, 228 routes. VERIFIED (capture); commit mapping NOT VERIFIED (`PRODUCTION_AS_FOUND_2026-10-26.md`). |

## 2. Expected state after deployment

| | TEST after the upgrade | Production after the release |
|---|---|---|
| Ledger | 85 / `0085` (**unchanged**; 0086 and 0087 live outside it) | 85 / `0085` (**unchanged**) |
| 0086 | present (`1|1|21`), file unchanged | present (`1|1|21`) |
| 0087 | present (`2` functions) | present (`2`) |
| Verification | `verify-0086.sql` 110 PASS and `verify-0087.sql` 24 PASS, plus the runner's set | the same |
| Code | Handler `2871b03d6be4…`, 242 routes, web `fb491a5` | the same Handler and routes, web `fb491a5`, Auth URLs and CORS origins as in PR 106 |
| Markers | none written for TEST | `~/ogevia-prd-before/db-0086.ok` = `85|0085|0086|0087` |

## 3. Deployment order

**TEST (upgrade; `OPERATOR_PROCEDURE_fb491a5.md` in `docs/releases/2026-10-26-redesign-operator/`)**: 0-4 pins, tarball and assembly (no change) → 5 baseline (no change) → 6 ledger re-read, 0086 present and 0087 absent → 7 named snapshot → 8 gates for all five stacks (API must show exactly the accept route + Handler; the other four "no difference") → **9 apply 0087 only** → 10 deploy the API stack (guard) → 11 web publish and verify → 12 smoke → 13 acceptance (V4, V5, V6 with the Owner) → 14 sweep → 15 final ledger and objects → 16 deployed record.

**Production (`OPERATOR_PROCEDURE_PRD_fb491a5.md`)**: 0-4 → 5 baseline and difference report → 6 ledger re-read, **0086 and 0087 both absent** → 7 named snapshot → 8 gates for all seven stacks → **9 apply 0086 then 0087 in ONE transaction** (verify-0086 110, verify-0087 24, runner set; marker written) → 10 deploy Auth → 11 deploy API → 12 web → 13 smoke → 14 Owner acceptance → 15 sweep and log search → 16 final ledger → 17 deployed record. **Database before code, always**: the API deploy is refused without the marker; `GET /v1/me` tolerates a database without 0087 (it checks that the function exists), but the accept route would fail with a server error until 0087 is applied, so the order stays as written.

## 4. How 0086 and 0087 interact

- 0087 **assumes 0086**: it replaces four 0086 functions (`complete_staff_invitation`, `note_my_sign_in`, `list_staff`, `update_staff`) and uses its tables. Applied to a database without 0086 it fails and changes nothing (tested: "0087 applied WITHOUT 0086 fails"). The TEST script refuses unless 0086 is complete (`1|1|21`); the production script refuses unless both are absent.
- 0087 also replaces two functions from **0048** (`disable_account`, `list_accounts`), which are part of the released 0001-0085 set. Their released text is untouched in `db/migrations`; 0087 replaces them in the database and its rollback restores the 0048 text. This does not change the 0001-0085 migration-set hash.
- 0086 is byte-identical to the file TEST holds (`8eb7b4a353300ba7…`, pinned in both packages); the production package applies exactly that file, then 0087, inside one `psql -1` transaction as `ogevia_owner`. If either file fails, **nothing** of either is kept.
- Neither migration is in the ledger; the release packages (pinned to 0001-0085) are unchanged in that respect. Promotion into `db/migrations` is a separate, later, Owner-approved step (decision D-P2).
- Behaviour already created under 0086 on TEST is **left alone**: memberships made active by 0086 stay active. 0087 changes invitations made from now on.

## 5. Ledger before and after

| | Before | After |
|---|---|---|
| TEST | 85 / `0085` | 85 / `0085` (a script test fails if any ledger write appears in the code; the run re-reads and compares) |
| Production | 85 / `0085` | 85 / `0085` |

The scripts stop (and, if a window was opened, close it and say whether the migration is applied) if the ledger is not exactly 85 / `0085` before, inside, or after the apply.

## 6. Rollback sequence if a deployment fails

Always in the reverse order of deployment: **web, then API (and Auth), then database.** All AWS recovery commands are YELLOW and NOT REHEARSED against AWS (only the database rollbacks were rehearsed, on a real PostgreSQL).

| Where it failed | Do | Evidence it worked |
|---|---|---|
| TEST, Step 9 (apply 0087) | Nothing to roll back: one transaction, nothing of 0087 is kept. Fix, re-run from Step 6. | `APPLY FAILED… nothing of 0087 was kept`, objects `1|1|21` and `0` |
| TEST, Step 10 (API) | R2: restore the previous Lambda code (captured at Step 5). The accept route stays in API Gateway; the old code answers it "not found". | CodeSha256 equals the baseline |
| TEST, Step 11 (web) | R1: restore the captured web files. | served `index.html` hash equals the captured one |
| TEST, 0087 must go | R3: `apply-0087-test.sh rollback` (0087 only; **0086 stays**). Do R1 and R2 first. An invitation left `invited` stays as it is; **after this rollback, do not invite anyone on TEST** (0086 would activate an existing sign-in at once, which is finding M-1). | objects `1|1|21` and `0`; ledger 85 / 0085; people counts identical |
| Production, Step 9 | One transaction: a failure keeps nothing of either migration. | `APPLY FAILED… nothing of 0086 was kept` |
| Production, Steps 10-12 | R2b (Auth URLs), R2 (API code), R1 (web), in that reverse order. | per the procedure |
| Production, both migrations must go | R3: `apply-0086-prd.sh rollback`: **0087 is removed first, then 0086, in one transaction.** BACKUP REQUIRED: it drops `staff_types` and `staff_profiles` **with their rows** (the counts are printed first). The pre-deployment snapshot must exist. | objects `0|0|0` and `0`; ledger 85 / 0085; people counts identical; `note_my_sign_in` on its 0025 definition |
| Production, only 0087 must go (0086 stays) | Not offered as a separate production script (the production package applies and rolls back as a pair). It is possible with the TEST script's logic but is not a prepared, approved production procedure: ask for it as a separate request. | n/a |
| Last resort | R4: snapshot restore. **Documented, not prepared, not rehearsed**; the snapshot also holds `ogevia_sv_test`, so it is never restored in place. | n/a |

## 7. Not established by this document

Live TEST and production state today; that the Operator's CloudShell reproduces the Handler asset key `2871b03d6be4…` (the TEST deployment reproduced the earlier key; Step 4 decides again); DNS for the production hostnames; the owner's GO, window and approval reference (none exist for this candidate).
