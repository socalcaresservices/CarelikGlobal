# Owner decisions needed before the TEST GO (prepared 2026-10-28; nothing here is signed or decided)

**Purpose.** Collect, in one place, the inputs the Owner supplies before a TEST-only GO for deployment SHA `fb491a554c0fdc484102025179c9c993f694b4e0`. Each decision has a recommendation and a blank answer field. **A blank field is an unanswered question, not consent.** Nothing is deployed, built for shipping, or applied by this document, and it does not request production.

## 0. Already decided by the Owner (recorded from the Owner's own message, not inferred)
| # | Decision | Owner's words / basis | Date |
|---|---|---|---|
| P1 | CI evidence accepted for the TEST request | "P1 is accepted based on the green 1b27f82 run." Run: https://github.com/socalcaresservices/CarelikGlobal/actions/runs/40778866660 (`validate`, `harness`, `postgres` all success) | 2026-10-28 |
| U6 | The CI `postgres` job's nondeterminism stays open as a **known flaky-test risk** | "Keep U6 open as a known flaky-test risk." It was red on `cea8b47` and green on `cd57ffb` and `1b27f82` (documentation-only differences); the failing test was never identified | 2026-10-28 |
| V7 | **Option B chosen for TEST**: a written Owner exception for TEST only; the independent SQL review is still required before any production request | "Proceed with option B for V7 and prepare the TEST tarball" (conditions as in section 4 option B: synthetic TEST data, verified snapshot first, additive and reversible 0087 with `apply-0087-test.sh rollback`, no production approval without V7 option A) | 2026-10-29 |
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
| Tarball sha256 | **Prepared 2026-10-29** (see section 6): `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`. The package accepts the placeholder approval reference in `BUILD_INFO.json` and uses the reference exported from the GO message at run time (`tarball-pin-check.sh`: "the approval reference exported from the GO message is used"), so the hash does not depend on your reference. I earlier wrote that the hash could not be known before the reference; that was stricter than the package requires | `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8` |
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

**Owner's decision (recorded 2026-10-29 from the Owner's message):** ☐ A ☑ **B, for TEST only** ☐ C ☐ other.
Exception: the Owner's own words are "Proceed with option B for V7"; the conditions are those listed for option B above and nothing more. I have not drafted additional exception wording for signature. **Not changed by this decision:** `SECURITY_REVIEW_0087.md` section 6 stays UNSIGNED (no reviewer has read the SQL), and **option A (a named second reviewer) remains required before any production request.**

**Reviewer packet for A or C** (what to read): `infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql` (sha256 `f9d75d8c…`), its rollback (`1789131e…`), the 24 checks in `docs/releases/2026-10-26-redesign-operator/scripts/verify-0087.sql`, `SECURITY_REVIEW_0087.md` sections 1, 3 and 5, and the 0086 file for context. Questions the reviewer should answer: can any caller activate someone else's membership; can acceptance be replayed or raced; can the invitation response or the lists reveal that an e-mail has an account or is disabled; can Disable/Enable or inactive/active bypass acceptance; do all eight `SECURITY DEFINER` functions pin `search_path` and revoke PUBLIC.

## 5. After these are answered
1. Owner returns this file's blanks and `TEST_APPROVAL_REQUEST.md` section 2 (or tells me the values).
2. The TEST tarball is already prepared (section 6). If you prefer your reference embedded in `BUILD_INFO.json`, tell me and I rebuild; the sha256 then changes and the old tarball is not used.
3. The Owner decides GO or NO-GO in `TEST_APPROVAL_REQUEST.md`. Only an explicit GO starts anything; the Operator then runs the procedure.

## 6. TEST tarball (prepared 2026-10-29; NOT uploaded, NOT deployed)
| Item | Value |
|---|---|
| File | `ogevia-operator-fb491a5.tar.gz`, 2,883,470 bytes |
| sha256 | `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8` (the value for `OGEVIA_EXPECT_TARBALL_SHA` / `TARBALL_SHA` in the GO message) |
| Code commit | `fb491a554c0fdc484102025179c9c993f694b4e0`, code tree `9c33b7b4e3d9d33c240c45385f2cad2ad40d1e8a` |
| `BUILD_INFO.json` | built 2026-10-29T00:56:11Z; `approval_ref` = the placeholder `APPROVAL-REF-PENDING-OWNER` (the Operator exports your real reference as `REF` in Step 0) |
| Manifest | `PACKAGE_MANIFEST.sha256`: 1075 files; sha256 `3262c3950cefd7b3569ac721bc2aeeaae663a52c69b96d485283f2654d853f4d` |
| Rebuild | `OGEVIA_BUILD_TIME=2026-10-29T00:56:11Z bash docs/releases/2026-10-26-redesign-operator/scripts/build-operator-tarball.sh --out-dir <DIR> --code-commit fb491a554c0fdc484102025179c9c993f694b4e0` (byte-identical while the package folder is unchanged; its last change is `215b7c6`) |
| Checks run on 2026-10-29, locally, on a fresh extraction | repeat build byte-identical; `sha256sum -c PACKAGE_MANIFEST.sha256` OK; `pnpm install --frozen-lockfile` OK; `tarball-pin-check.sh` all PASS, `PINS HOLD`; offline `cdk synth` and `assembly_check.py`: five TEST stacks only, Handler asset `2871b03d6be4…`, IdentityHandler unchanged, 242 routes, 14 staff routes, all five stack fingerprints equal the release (`c2c489ae…` for the API) |
| What this does not prove | The Handler key reproducing **in the Operator's CloudShell** (Step 4 decides there), anything on AWS, and nothing about TEST's live state. The local synth used a clearly fake non-approval value for the reference, discarded |
| Delivery | the file and its `.sha256` are handed to you for upload to CloudShell (Actions, Upload files) as `~/ogevia-operator-fb491a5.tar.gz`. The tarball is not committed to the repository |

## 7. Inputs supplied on 2026-10-29 (05:09Z) and the admin host IP procedure
| Input | Value | Note |
|---|---|---|
| Approval reference | `OGEVIA-TEST-GO-20261028` | matches `^[A-Za-z0-9._-]{6,64}$`; exported by the Operator as `REF` in Step 0. **It is not a GO** |
| Operator | Stella Okereke | The Owner states the Operator and the approver are **different people**. The approver's name was not given and is needed for the decision record. (The 2026-10-26 checklist named Stella Okereke as both Owner and Operator; that record is history and unchanged.) |
| Window | 2026-10-29 05:00Z to 09:00Z | Within the 12-hour maximum. **It was already open when recorded (05:09Z), so about 3 h 50 min remained.** Procedure Steps 7 and 9 require the snapshot and the apply to fall inside it; a late start may not leave time for V4-V6, which run after the upgrade |
| Admin host private IP | not obtained | **I could not run the lookup**: the development container has no AWS CLI, no `boto3` and, by design (procedure status line), no AWS access |
| GO decision, approver name | blank | nothing is signed |

**How the admin host IP is obtained (documented parts, and one adapted command).** The repository documents (a) finding the host by its tag and running state: `docs/aws/CLOUDSHELL_PHASE0_COUNTS.md` section 3.3 (`describe-instances` with `Name=tag:Name,Values=ogevia-db-admin-temp` and `Name=instance-state-name,Values=running`; if no `i-` id comes back it says STOP, **do not start the host**, tell Claude), and (b) that the TEST script itself reads the IP live and requires: host running, exactly one network interface with exactly one private IPv4, an RFC 1918 address, equal to `OGEVIA_EXPECT_HOST_IP` if set, mapping to exactly one interface in the VPC that belongs to the host (`ledger-recheck.sh`, "--host-ip MODE"). **The repository has no verbatim command that prints the private IP**; the one below is my adaptation of (a), **NOT RUN**:

```
aws ec2 describe-instances --region us-west-2 --filters "Name=tag:Name,Values=ogevia-db-admin-temp" "Name=instance-state-name,Values=running" --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,length(NetworkInterfaces),length(NetworkInterfaces[0].PrivateIpAddresses)]' --output text
```
Expected: one line `i-...  10.x.x.x  1  1` (instance id, private IP, one interface, one address). Stop if there is no line (host not running: do not start it, tell the Owner), more than one line, or the last two numbers are not `1  1`. The Operator sets `HOSTIP=<that private IP>` in Step 0 and pastes the line back. Read-only; changes nothing. The script's own live check then confirms it, so a mistyped IP is refused, not trusted.

**Still needed before the Operator starts:** the GO signed by the approver (name, date, time), the tarball uploaded as `~/ogevia-operator-fb491a5.tar.gz` with sha256 `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`, the admin host IP, and the TEST freeze with Demo users warned. The Owner's manifest review and the Operator readiness list (section 1) are still not recorded.
