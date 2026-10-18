# Review updates checklist (persistent)

Source: owner directive of 2026-10-18 plus "Ogevia UI Wording & Navigation Revision — Review" (Claude Docs artifact BbkTV31dj1nZoeZGwaJDur, read 2026-10-18; its content matches the directive).
Everything is LOCAL. Nothing pushed, merged or deployed. Statuses: DONE / PARTIAL / MISSING / BLOCKED / UNKNOWN.

## Batch 0 baseline (2026-10-18)
- Working branch: `local/review-updates`, created from `6127967…` = integration tip `3159e520a7b9bc7006ee82d526a907622d30d97c` + 3 local commits (`d893276` DB test-fixture repair from PR #100, `fe2a252` UI simplification, `6127967` assignment-outcome fix). Prior branch `local/ui-simplification-review` left untouched. Working tree was clean.
- Integration branch: local `integration/compliance-attention-onto-scheduling-recruiting` = `3159e52`. `origin/` copy is `bffa1fc`, an ANCESTOR of `3159e52` (older); the local tip is the newer one. Not reset to the older SHA.
- White/Minimal appearance work: contained (`d049fca`, `a531c07` are ancestors of HEAD). Goodall `origin/claude/determined-goodall-syvv7s` (`ea22bbf`): fully contained (0 commits not in HEAD). Migration conflict resolution: contained; local migration files 0001 to 0077, no gaps checked beyond count (77 files).
- Ledgers: TEST read earlier by the owner-supplied run: 52 migrations at 2026-10-17T16:29:27Z. Since then the owner executed the TEST operation of 2026-10-18 (migrations 0053 to 0077 applied through the /32 wrapper, verified in that session's output). Current TEST ledger not re-read now: UNKNOWN until read again. Production (`ogevia_prd`) ledger: UNKNOWN, never queried; it exists on the same RDS instance. New migrations only, none edited.
- Read-only ledger command (existing, verified in repo): `bash infra/aws/slice/ledger-check-temp-access.sh test --host-ip` with `OGEVIA_EXPECT_HOST_IP=<admin host IP>` (see `docs/releases/2026-10-18-interface-simplification/LEDGER_CHECK_INSTRUCTIONS.md`, `TEMP_DB_ACCESS_PROCEDURE.md`). Production use needs the owner's separate approval; no database names, endpoints or columns are guessed here.
- Five-board handoff: `OGEVIA_Approved_Five_Board_OneNote_Handoff_1.zip` (sha256 677ff860…7108) is NOT in the repository or on this machine. Present: `FIVE_BOARD_COMPARISON.md` (vs `a9a7d2ee`) and `FIVE_BOARD_MATRIX_88.md` (88 rows: 26 IMPLEMENTED, 45 PARTIAL, 14 MISSING, 1 CONFLICT, 2 UNVERIFIABLE at that time). Missing: the zip itself, so a fresh comparison against the supplied approved handoff is BLOCKED; rows are re-marked from code evidence only.
- Deployment triggers: see the production-readiness report (to be written after Batch 1).

## Directive status before changes (from code and earlier evidence; tests per batch will confirm)
| Item | Status before | Note |
|---|---|---|
| B1.1 document upload failure | MISSING (cause hypothesis only) | key `*/client-documents/*/*` not in role/endpoint policy |
| B1.2 own-document approval | PARTIAL | DB guard `documents.review_own` exists (0074); direct-API proof and reload proof missing |
| B1.3 pin checker | MISSING | failed `git status` read as clean |
| B1.4 ledger-check-temp-access test | UNKNOWN | to be reproduced |
| B2.1 assignment outcome | PARTIAL | display names the hours blocker; one server-side decision and submit recheck not verified |
| B2.2 hours buckets | PARTIAL | single-bucket model exists (0052); equation and per-authorization over-limit unverified |
| B2.3 caregiver/office balance | UNKNOWN |  |
| B2.4 attention timing | PARTIAL | 48 h / start rule computed in web app, 0077 server counts; admin-review 24 h and confirmation 48 h exist per matrix |
| B2.5 counts definitions | PARTIAL |  |
| B3 wording and names | MISSING (some wording done in fe2a252) |  |
| B4 navigation | MISSING |  |
| B5 appearance matrix, screenshots, final checklist | MISSING |  |
