# Production release pins: migrations 0086, 0087, 0088 (written 2026-11-01 16:47 UTC)

**Owner GO (written, in conversation, 2026-11-01): "GO ... Approved Commit: f117510 ... Deployment Window: Effective now ... I authorize proceeding with the approved PRD-0088 release activities for commit f117510 within the approved window."**
Accepted by the owner in the GO: the CORS template catch-up on `ApiF70053CD` (admin and app origins added to the template; the live API already allows both); no environment-tag drift; the duplicate `https://app.ogevia.com` in `AllowOrigins` (if API Gateway rejects it, CloudFormation rolls back; risk accepted); data class "approved under existing production controls and documented release process".
**Set by Claude, not stated by the owner (change by re-filling):** approval reference `GO-PRD-0088-20261101`; the window below. The owner wrote "effective now" without an end; a 4-hour window was chosen. No step may begin after the end; a step that began may finish. If the work cannot finish, the remaining steps wait for a new, written window.
**Scope:** the Phase E package as documented, including (stated for the record) the retirement of the 5 active onboarding requirements found by the dry-run probe (recoverable by the rollback) and no change to enforcement, sign-in emails, TEST, Cognito or the network.

| Pin | Value |
|---|---|
| Approval reference | `GO-PRD-0088-20261101` |
| Window (UTC) | 2026-11-01 16:45:00 to 2026-11-01 20:45:00 |
| Application commit (the ONE approved commit; REPO checkout) | `f11751071e5f3199bd5d254300372a7466007c06` |
| Application code vs the dry run | identical: `git diff 63374f7..f117510` outside `docs/` is empty (VERIFIED); only documents and scripts differ |
| Handler / Identity code asset keys | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7` / `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759` (from a local synth at the dry-run commit; the release-night `synth` must reproduce them or it stops) |
| Migration pins (0088; all-88 set; 0086-0088 rollback set) | `dc20f327794a6f9b6e4f79d201550f1d0a9970e2e4b800c27b598213c82cf34f`; `049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c`; `4b53cb1908a5939bb3aac47ca0725b16d264690d2d83f78e4cca7cae4d035d05` |

**sha256 of the release files (verify before running; they are in this folder at the branch tip):**
```
48e31fd4ed3355087922e16043dec61546e5c8bd5db1239e7e43f28718d378fe  STELLA_PRD_DB.sh
95afe445683376815fc7d262e561f7c7dd3e2f63258757ccf1f603a0e9cfe2b2  STELLA_PRD_DEPLOY.sh
05db104472a7934eec695eb7b026d3179de9ab4a9581ff7001a1854b726f9830  STELLA_PRD_READONLY.sql
e905e7b751e0998d5c240be58fd39710fbe411991321d014e47ddb97c80b7a26  diff_gate_prd0088.py
```
The gate and the SQL are byte-identical to the dry-run copies (VERIFIED by `cmp`). The scripts' commit is later than the application commit; it contains only the filled scripts and documents. Nothing is deployed until the Operator runs the steps of `PRD_RUNBOOK.md` part 3; each mutating step also needs its typed phrase. The sequence stops at the first failed check; rollback is the owner's decision (web, then API, then database).
