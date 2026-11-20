# DEV sign-off checklist: PR #113 at 96dd96a

Environment: DEV = local harness (`docs/releases/2026-11-20-dev-validation/DEV_DEPLOYMENT_PLAN.md`). Mark each line PASS, FAIL or NOT RUN, with who and when. A line not run is a failed line. Nothing here is a deployment or an approval.

## A. Build and database
| # | Check | Result |
|---|---|---|
| A1 | Clean checkout at `96dd96a`; `pnpm install --frozen-lockfile` | PASS (rehearsal 2026-11-20) |
| A2 | `harness:setup`: 107 migrations, seed | PASS (rehearsal) |
| A3 | `harness:build` | PASS (rehearsal) |
| A4 | `pnpm lint`, `pnpm typecheck`, `pnpm build` | PASS (local, at `c19453d`) |
| A5 | Unit suites and database suites (`pnpm test:all`) at `96dd96a` | NOT RUN at `96dd96a`; passed on `c19453d` and CI `4b004f9` |
| A6 | Migration 0109: apply, rollback, reapply | PASS (rehearsal) |
| A7 | CI green on `96dd96a` (harness, validate, postgres) | PASS (all three green) |
| A8 | Staff header at 390 px: no sideways scroll (defect found and fixed in the harness pass) | PASS (browser pass, desktop and phone) |

## B. Smoke and switch state
| # | Check | Result |
|---|---|---|
| B1 | Smoke with 0109 absent (switch-OFF equivalent): 45/45 | PASS (rehearsal) |
| B2 | Smoke after 0109 applied: 45/45 | PASS (rehearsal) |
| B3 | `cdk synth`: `requestCleanup` false adds no route; true adds exactly the three routes | NOT RUN (needs TEST CDK synth) |
| B4 | With 0109 removed, the three new buttons answer "not available in this environment yet", not an error | NOT RUN (browser) |

## C. The ten go-live items (manual check in the harness; automated evidence in the tracker)
| # | Item | Manual check | Result |
|---|---|---|---|
| C1 | Calendar CSV order | Reports, client monthly calendar, Export CSV: rows by service code, name, period start | NOT RUN |
| C2 | Export ordering | Sort a column on Incidents, Credentials, Audit, Authorizations, Clients, Candidates; Export; the file order equals the screen. Billing submission items and correction history use the documented default order | NOT RUN |
| C3 | Caregiver picker | Add shift, reassign, assignments card, outage visits, make-up: caregivers A-Z; a shared name shows its code; a list over 8 has a find box | NOT RUN |
| C4 | Shift drawer | Schedule: Assign, call-out, cancel, change time, make-up, history open in the drawer; Escape closes; the list does not move | NOT RUN |
| C5 | Dashboard refresh after shift updates | Make a call-out on Schedule; Home figures and action items update without a manual reload | NOT RUN |
| C6 | Requests refresh after shift updates | After a shift change, Care requests and pickup lists reflect it | NOT RUN |
| C7 | Office filtering (VIS-26 reading) | Billing review: Review reason filter lists only present reasons, combines with the others, Clear filters resets | NOT RUN |
| C8 | Homepage updates | Home Refresh updates the figures, shows "Updated", and on failure keeps the last figures with Retry | NOT RUN |
| C9 | Mobile improvements | At 390 px: Documents and Staff show a Sort by control and a direction button (44 px); hidden at desktop width | NOT RUN (browser; a real phone is still needed) |
| C10 | Scheduling refusal messages | Assign a caregiver who already has a shift at that time: the server sentence plus "What to do:" | NOT RUN |

## D. The three new behaviors, one at a time (0109 applied)
| # | Check | Result |
|---|---|---|
| D1 | Alerts pill opens the list; Mark read; Mark all read; only the person's own alerts change | NOT RUN |
| D2 | Cancel a document request with no upload; reason required; closed; none offered when an upload exists | NOT RUN |
| D3 | Retire a duplicate document type; refused for the CPR/TB type and with open requests | NOT RUN |

## E. Security and data
| # | Check | Result |
|---|---|---|
| E1 | Cross-tenant and role checks (existing suites: tenant isolation, permissions) | PASS in CI and local suites |
| E2 | No identifiers or reasons in logs for the new routes (API test) | PASS (API tests) |
| E3 | Synthetic data only; the harness refused any non-local database | PASS |

## F. Decisions the owner must make before TEST
1. Confirm the meaning of items 1, 2, 3, 4, 7, 8, 9 and 10 (the written list is not in the repository).
2. Confirm DEV is the local harness (Phase B) and no AWS DEV is needed.
3. Approve a TEST plan for `96dd96a` (to be prepared): 0109 on the isolated TEST database after a snapshot, the three routes with `requestCleanup` ON, web from the same commit.

## Sign-off
DEV validated by: ______________________  date: ____________  result: PASS / FAIL
