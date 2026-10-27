# Production as found: 2026-10-26

**This is a baseline, not a deployment record.** It states what was observed in production on 2026-10-26, from a read-only capture run by the Owner in CloudShell, and what the repository says about how production got there. It does **not** reconstruct the missing deployed records of 2026-10-21 to 2026-10-23, and it does not claim to know which commit those deployments used. Where a commit mapping is unknown it says **NOT VERIFIED**. Nothing here was changed, deployed or approved by writing it.

Labels: **VERIFIED** (observed in the capture, or read from a committed file), **INFERRED** (follows from verified facts but was not itself observed), **NOT VERIFIED** (not established).
Source of the capture figures: `docs/releases/2026-10-26-redesign/PRODUCTION_RELEASE_PREPARATION.md` section 2 (the Owner's CloudShell output of 2026-10-26; no secret value or record content was read).

Written 2026-10-27 on the Owner's instruction ("Write the 'production as found' baseline now. Clearly separate verified observations from unknown commit mappings").

## 1. What was observed (2026-10-26, read-only)
| Item | Observation | Label |
|---|---|---|
| Account, region | `300094796789`, `us-west-2` | VERIFIED |
| `Ogevia-prd-Auth` | exists, created 2026-10-21, settled, termination protection on | VERIFIED |
| `Ogevia-prd-ServiceVerificationApi` | updated 2026-10-21, settled; API `zk527zk4ua` with 228 routes (244 template resources) | VERIFIED |
| `Ogevia-prd-WebHosting` | updated 2026-10-23, settled | VERIFIED |
| `Ogevia-prd-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, shared `Ogevia-prod-NetworkEgress` | exist, settled | VERIFIED |
| API Lambda code | asset `debd1d43…`, last modified 2026-10-21; serves database `ogevia_prd` with `OGEVIA_ENV=prd`; the live code zip was downloaded as a recovery copy and the previous asset exists in the CDK bucket (260,561 bytes) | VERIFIED |
| Web | the served bundle identifies itself as `e80b770210c54e423d28ecf48e00f1dda9506cec`, environment `production`, and calls only the production API host; 83 files were captured | VERIFIED (the label; see section 3) |
| Database `ogevia_prd` | migration ledger: 85 applied, latest 0085, applied 2026-10-20; enforcement settings "0 of 0 agencies" | VERIFIED. What the tables hold: NOT VERIFIED (row counts were deliberately not collected) |
| RDS `ogevia-prod-postgres` (shared with TEST) | available, private, encrypted, 7-day backups, deletion protection on, 20 manual snapshots | VERIFIED |
| Cognito | production pool `us-west-2_FHJoX71ca` (separate from the TEST pool `us-west-2_849AYz5J7`); MFA on for both pools | VERIFIED |
| Hostnames `app.ogevia.com`, `admin.ogevia.com` | the WebHosting stack equals the 2026-10-26 release template, so any aliases it holds are in place; whether DNS points at it was not examined | NOT VERIFIED (DNS) |
| Data classification | the Owner stated on 2026-10-20 that production holds synthetic data only; nothing was counted or classified in the capture | NOT VERIFIED (statement only) |

## 2. What the repository says about how production got here
| Date | Event | Evidence strength |
|---|---|---|
| 2026-10-10 | First `Ogevia-prd-*` deployment (Lambda with `DB_NAME=ogevia_prd`); `Ogevia-prd-WebHosting` and `-ServiceVerificationApi` `UPDATE_COMPLETE` | Owner-provided AWS output summarised in `docs/aws/PRODUCTION_DEPLOYMENT.md`; no commit recorded |
| 2026-10-20 | Ledger shows 85 migrations applied, latest 0085 | The capture (VERIFIED). A written GO in the repository names a window of 2026-10-21T17:00Z to 21:00Z (`71936e6`); how the 2026-10-20 ledger timestamps relate to that window was not established: NOT VERIFIED |
| 2026-10-21 | Dedicated production sign-in pool and client created (`Ogevia-prd-Auth`); API stack updated; Lambda asset `debd1d43…` | The capture shows the stacks and dates (VERIFIED). The repository's auth-separation package names a candidate `9e8582b` (an operator package, prepared for approval). No deployed record names the commit actually deployed: NOT VERIFIED |
| 2026-10-22 | The production site's security header blocked sign-in; a fix (`efcacd0`) was proposed, "NOT deployed" at the time of writing | `docs/releases/2026-10-21-auth-separation/FOLLOWUP_WEB_HEADERS.md` |
| 2026-10-23 | `Ogevia-prd-WebHosting` updated (the permanent-hostnames code `db67c95` is committed the same day) | The update date is VERIFIED (capture); that the update contained `efcacd0` and `db67c95` is INFERRED from the stack equalling the 2026-10-26 release template |

## 3. Commit mapping: what is and is not known
| Production part | Commit mapping | Label |
|---|---|---|
| Web bundle | the bundle's own version string says `e80b770` (2026-10-19). The label is a build-time string. The bundle was built with production's own embedded sign-in values, and the stack that serves it was updated later than `e80b770`, so the label alone does not prove the source tree. | The label is VERIFIED; the source tree is NOT VERIFIED |
| API Lambda code (`debd1d43…`) | never mapped to a commit in any committed document | NOT VERIFIED |
| Stack templates (Auth, API, WebHosting) | each equals what the 2026-10-26 release code synthesizes, apart from the differences the release gate lists (API: 13 staff routes, Handler asset, two CORS origins; Auth: four URL properties; WebHosting: an export only) | VERIFIED by the gate against the capture |
| Database schema | ledger 85 / 0085 (count and latest version read). Whether each ledger row's checksum equals the repository file was not part of this capture | VERIFIED for the count and latest version; checksums and the schema's actual objects beyond the ledger: NOT VERIFIED |

## 4. Production changes made outside GitHub (known or possible)
- Every deployment so far was run by hand by an operator in CloudShell; there is no deployment pipeline, so the commands, dates and approvals exist only in operator-pasted output and in this repository's plans. NOT VERIFIED beyond the dates above.
- The AWS foundation (VPC, subnets, security groups, SSM endpoints, the admin host, the RDS instance, IAM roles) was created by hand before CDK (`CLAUDE.md` section 7). Their current settings are VERIFIED only where the capture read them (RDS above).
- 20 manual RDS snapshots exist (VERIFIED, count only).
- Cognito users and the owner relink were created or moved by invitation and operator-run SQL; the scripts are in the repository, the executions are not recorded. NOT VERIFIED.
- DNS, the ACM certificate and any CloudFront alias outside the stack: NOT VERIFIED.
- The production alarm email subscription is opt-in in code; whether it is set: NOT VERIFIED.

## 5. What this baseline is for
- It is the starting point of the drift check required before every release (`docs/TESTING_AND_RELEASE_PROCESS.md` section 8.1). The 2026-10-26 release's expected-only gate already compares the live Auth, API and WebHosting templates with this baseline's values and stops on anything else.
- It cannot detect what it did not record (for example Lambda code that differs without a template change). That limit is stated in `docs/aws/DRIFT_MONITORING_PROPOSAL.md`.
- The first release deployed under the new record rule (`DEPLOYED_RECORD_PRD.md`) supersedes this document as the baseline. Unknown mappings stay NOT VERIFIED until a later release proves them; they are not to be filled in from memory.
