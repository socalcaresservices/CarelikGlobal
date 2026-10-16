# Operator checklist: TEST web release (AWS CloudShell, us-west-2, administrator role)

Do not start without the owner's approved `PHASE_C_AUTHORIZATION_STATEMENT.md`. Tick each box and paste the output into the evidence folder. **Any `REFUSED`, `FAILED` or `STOP`: stop, change nothing, send the output to the owner.** Use `bash` explicitly. TEST only; synthetic data only.

## A. Before the window
- [ ] The owner approved the statement (reference `owner-go-test-web-0052-2026-10-16`, window set). The pull request was reviewed and CI was green on the commit being used.
- [ ] No other change to TEST is in progress.
- [ ] CloudShell is in **us-west-2**. `aws sts get-caller-identity --query Account --output text` prints `300094796789`.

## B. Get the code (about 2 minutes)
```bash
git clone https://github.com/socalcaresservices/CarelikGlobal.git     # skip if already cloned
cd CarelikGlobal && git fetch origin && git checkout <branch or commit named by the owner>
git rev-parse HEAD                                                       # write the full commit down
sha256sum infra/aws/slice/test-web-release.sh                            # must equal the checksum in the statement
```
- [ ] Commit recorded: ______________________  - [ ] Script checksum equals the statement.

## C. Read-only and local steps (before the window opens or inside it)
| # | Command | Expected | Stop if |
|---|---|---|---|
| C1 | `bash infra/aws/slice/test-web-release.sh preflight` | `PREFLIGHT OK`; baseline `d82fefc`; TEST web `https://d2xumch5w0izfg.cloudfront.net`; `live TEST config.json VITE_APP_ENV: (absent)` (or `test`); a `config.json sha256` line | any `REFUSED`/`FAILED`: wrong commit or application files, wrong account, a TEST resource equal to a PROD resource, live config pointing elsewhere or saying production |
| C2 | `curl -sI https://d3l4psdkokkvnb.cloudfront.net/ \| grep -i last-modified` | a date: **write it down** (PROD marker, before) | – |
| C3 | `bash infra/aws/slice/test-web-release.sh build` (5 to 10 minutes) | `BUILD OK. label test confirmed.` and an entry script name. A name different from `index-DqZf2Qg2.js` is a note, not a stop | `build is not labelled test`, `labelled production`, build failure |
| C4 | `bash infra/aws/slice/test-web-release.sh capture` | `CAPTURE OK. N files saved ...` and the bucket versioning state | any failure |

## D. Inside the window
- [ ] Time now (UTC) is before the window end. Set `OGEVIA_WINDOW_END` to the window end in UTC, for example `2026-10-16T22:30:00Z`.
- [ ] Publish (the only step that writes). Type `PUBLISH TEST` when asked:
```bash
OGEVIA_DEPLOY_APPROVAL=owner-go-test-web-0052-2026-10-16 OGEVIA_WINDOW_END=<UTC end time> bash infra/aws/slice/test-web-release.sh publish
```
Expected: `PUBLISH DONE (TEST)` (2 to 4 minutes including the invalidation wait). Stop if it refuses or fails; do not retry blindly: send the output.
- [ ] `bash infra/aws/slice/test-web-release.sh verify` Expected: every line `OK`: front page 200; live `index.html` byte-identical to the build; served scripts carry the test label; no production label; `config.json` unchanged; the API rejects an anonymous request. Any `FAIL`: roll back (`ROLLBACK.md`).
- [ ] PROD marker after: `curl -sI https://d3l4psdkokkvnb.cloudfront.net/ | grep -i last-modified` equals the value from C2.

## E. Browser acceptance (owner and testers; synthetic data only)
Open `https://d2xumch5w0izfg.cloudfront.net`. **First check, a hard stop: SMK-07.**
- [ ] **SMK-07:** the amber banner **"TEST — synthetic data only"** is visible on every page after sign-in, at desktop width and at phone width (390 px). *Not visible: roll back at once.*
- [ ] SMK-01 to SMK-06: sign-in per role; Home shows numbers; Schedule opens; a caregiver sees only assigned clients; a visit can be started and ended; an anonymous API call returns 401.
- [ ] VIS-23: starting a visit with no scheduled shift asks for a reason and the visit goes to review.
- [ ] VIS-14, 15, 16, 19: every confirmation choice is offered. VIS-20, 21: submit needs the attestation.
- [ ] SCH-15: an availability override needs a chosen client. SCH-18, 24: a caregiver can pick up an open shift.
- [ ] VIS-50 to 53: visit-rule settings show history and the "Unverified, not a payer rule" label.
- [ ] Accounts page (owner only): view the list. **Do not Disable/Enable** anyone except a synthetic account that exists only in TEST (the sign-in pool is shared with PROD).
- [ ] No error screens or console errors on core screens; no horizontal scrolling at 390 px; PROD still shows no TEST banner.
- [ ] Screenshots of the banner (desktop and phone) saved to the evidence folder.

## F. After
- [ ] Send the owner: `~/ogevia-test-web-release-d82fefc/release.log`, the output of each step, the PROD marker values, the browser results and screenshots.
- [ ] Claude Code records the result in `docs/releases/2026-10-13-wave1/CHECKLIST.md` Phase C. `smoke.py`, regression and seed writes remain separate approvals.
- [ ] Keep `~/ogevia-test-web-release-d82fefc/rollback/` until the owner closes the release.
