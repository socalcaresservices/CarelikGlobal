# Owner decisions needed before the TEST GO (prepared 2026-10-28; nothing here is signed or decided)

**Purpose.** Collect, in one place, the inputs the Owner supplies before a TEST-only GO for deployment SHA `fb491a554c0fdc484102025179c9c993f694b4e0`. Each decision has a recommendation and a blank answer field. **A blank field is an unanswered question, not consent.** Nothing is deployed, built for shipping, or applied by this document, and it does not request production.

## 0. Already decided by the Owner (recorded from the Owner's own message, not inferred)
| # | Decision | Owner's words / basis | Date |
|---|---|---|---|
| P1 | CI evidence accepted for the TEST request | "P1 is accepted based on the green 1b27f82 run." Run: https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40778866660 (`validate`, `harness`, `postgres` all success) | 2026-10-28 |
| U6 | The CI `postgres` job's nondeterminism stays open as a **known flaky-test risk** | "Keep U6 open as a known flaky-test risk." It was red on `cea8b47` and green on `cd57ffb` and `1b27f82` (documentation-only differences); the failing test was never identified | 2026-10-28 |
| Scope | No deployment actions; only preparation; no change to `main`, TEST, production or `ogevia_prd` without an explicit GO | Owner's message | 2026-10-28 |

Accepting P1 does **not** sign Phase A, does not accept the manifest, and does not decide V7.

## 1. Operator confirmation
| Item | State |
|---|---|
| Operator for the TEST window | **OWNER TO CONFIRM.** The records name the operator differently: `docs/releases/2026-10-26-redesign/CHECKLIST.md` (TEST, 2026-10-26) says "Stella Okereke as Operator and Owner"; PR 98 (2026-10-15, Release 0052) names "Ogechi Okereke". This preparation does not choose between them. Write the person's full name exactly as it should appear in the deployed record: ______________ |
| Operator has read `OPERATOR_PROCEDURE_fb491a5.md` sections 1-9 | ☐ OPEN (the Operator ticks) |
| AWS CloudShell in `us-west-2`, account `300094796789`, can open an authenticated session | ☐ OPEN / NOT VERIFIED |
| Session Manager plugin, PostgreSQL client 15+, Node 22, pnpm 9.15.4, `jq`, `curl`, `openssl` available (procedure section 1 toolchain; Step 0 checks them) | ☐ OPEN / NOT VERIFIED |
| A **second** CloudShell session available for recovery (procedure section 4) | ☐ OPEN |
| Operator can upload the tarball to CloudShell (Actions, Upload files) | ☐ OPEN |
| Operator can paste each step's output back for review before the next step | ☐ OPEN |
| Owner is available at a keyboard for the whole window (V4 creates a Cognito user and needs the Owner's inbox) | ☐ OPEN |
| If Operator and Owner are the same person, that is stated here (the earlier checklist used "no separate validator"): ______________ |

## 2. TEST approval inputs (fill `TEST_APPROVAL_REQUEST.md` section 2 from these)
| Field | Guidance | Answer |
|---|---|---|
| Approval reference | 6-64 characters from `A-Za-z0-9._-` (the scripts refuse anything else). Choose your own, for example `owner-go-test-fb491a5-YYYYMMDD-01`; I do not invent one | ______________ |
| Window start / end, **UTC**, at most 12 hours | Pick a time when you can sit with the Operator. **Clock change:** US daylight saving time ends on **Sunday 1 November 2026**. Before it, Pacific = UTC-7; from 02:00 on 1 November, Pacific = UTC-8. Example: a window starting 9:00 Pacific on 31 October is 16:00Z; starting 9:00 Pacific on 2 November is 17:00Z. Estimate, not measured: allow 3-4 hours for procedure Steps 0-12; V4-V6 follow | start ______________Z  end ______________Z |
| Admin host private IP (host tagged `ogevia-db-admin-temp`) | Not in the repository. The Operator can read it with this **read-only** command, which has NOT been run: `aws ec2 describe-instances --region us-west-2 --filters Name=tag:Name,Values=ogevia-db-admin-temp --query 'Reservations[].Instances[].[InstanceId,State.Name,PrivateIpAddress]' --output text`. Whether the host must be started first is NOT VERIFIED; the procedure's Step 5/6 outputs decide | ______________ |
| Tarball sha256 | produced by me when the Owner returns the approval reference (the reference is inside `BUILD_INFO.json`, so the hash cannot be known earlier) | filled after the build |
| TEST freeze and Demo-user warning (procedure D5) | Who warns Demo users, and when: ______________ | ______________ |
| Inboxes for V4/V5 e-mails | the Owner controls `admin.ogevia+v4cg@gmail.com` (V4 step C1). For V5's M-1 step an existing sign-in outside the TEST agency, reachable by e-mail, is needed: accounts D or E if they can sign in (NOT VERIFIED); else BLOCKED | ______________ |

## 3. Manifest review resolution
The Owner's review of `RELEASE_MANIFEST.md` is **not yet recorded**. This table is what that review should check; the "Prepared resolution" column is mine and is not the Owner's acceptance.

| # | Item raised in the 2026-10-28 review | Prepared resolution | Owner |
|---|---|---|---|
| M1 | Stale "documents head 215b7c6" references | Replaced by role definitions: deployment SHA, CI-tested SHAs, documentation head = branch head, operator package = tarball sha256 (commit `1b27f82`) | ☐ accepted ☐ comment: ______ |
| M2 | File counts and diffstat predated later commits | Counts pinned to fixed SHAs (`fb491a5` against `24fd8b1` and `644d6e2`) plus a recompute command | ☐ accepted ☐ comment: ______ |
| M3 | DST fix not described precisely | Described in manifest section 4 (one test line, no assertion changed, unrelated to this work) | ☐ accepted ☐ comment: ______ |
| M4 | Section 11 over-claimed "no other failure remained" | Corrected; CI listed by tested SHA with run links; P1 acceptance and U6 are recorded here and in `OPEN_RISKS_AND_ASSUMPTIONS.md` | ☐ accepted ☐ comment: ______ |
| M5 | Sections 1-3, 5-9: production/TEST "now" figures were not re-read today | Unchanged and labelled as from 2026-10-26 records; they are re-read live at procedure Steps 5-6 | ☐ accepted ☐ comment: ______ |
| M6 | Release checklist missing for the candidate | `CHECKLIST.md`, all approvals unsigned | ☐ accepted ☐ comment: ______ |

Owner's review of the manifest: ☐ reviewed, accepted for a TEST-only GO ☐ reviewed, changes requested ☐ not yet reviewed. Name / date: ______________

## 4. V7: the independent review of the 0087 SQL (decision)
**Fact:** `SECURITY_REVIEW_0087.md` is the author's own checklist. The same session wrote and reviewed it, so it is **not independent**. No second person has read the SQL. The scripts do not require a V7 signature; the release process and the earlier AI second read of 0086 treat it as a control.

| Option | What it means | Cost / risk |
|---|---|---|
| **A. Named second reviewer signs `SECURITY_REVIEW_0087.md` section 6 before the TEST GO** | A person who did not write it reads the SQL (328 lines plus the 74-line, 24-check verification file) against the checklist | Needs a person; strongest |
| **B. Written Owner exception for TEST only; review before production** | The Owner states in writing that TEST proceeds without an independent read because TEST holds synthetic data, a verified snapshot is taken first, 0087 is additive and reversible (`apply-0087-test.sh rollback`), and no production approval follows without V7 | Moves the risk to TEST; weakens nothing for production |
| **C. Independent AI second read, as was done for 0086** | A fresh read of the migration by a separate reviewer session, with its findings recorded in the repository, before the GO | Not a human review; the checklist's intent is a person. Findings must be treated like M-1/L-1 were |

**Recommendation: B for TEST, with A required before any production request** (optionally C first, because it is quick and found M-1 last time). Reason: TEST is synthetic, reversible and snapshot-protected, while production holds real agency data. This is a recommendation; the choice is the Owner's.

**Owner's decision:** ☐ A (reviewer name ______________, to be completed before the GO) ☐ B (written exception, wording below) ☐ C ☐ other ______________
Exception wording, if B (Owner writes it; not pre-written for signature): ____________________________________________

**Reviewer packet for A or C** (what to read): `infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql` (sha256 `f9d75d8c…`), its rollback (`1789131e…`), the 24 checks in `docs/releases/2026-10-26-redesign-operator/scripts/verify-0087.sql`, `SECURITY_REVIEW_0087.md` sections 1, 3 and 5, and the 0086 file for context. Questions the reviewer should answer: can any caller activate someone else's membership; can acceptance be replayed or raced; can the invitation response or the lists reveal that an e-mail has an account or is disabled; can Disable/Enable or inactive/active bypass acceptance; do all eight `SECURITY DEFINER` functions pin `search_path` and revoke PUBLIC.

## 5. After these are answered
1. Owner returns this file's blanks and `TEST_APPROVAL_REQUEST.md` section 2 (or tells me the values).
2. I build the shippable TEST tarball with the approval reference and give its sha256. **No build happens before that.**
3. The Owner decides GO or NO-GO in `TEST_APPROVAL_REQUEST.md`. Only an explicit GO starts anything; the Operator then runs the procedure.
