# Ogevia scheduling, authorization and dashboard: review package

**Date:** 2026-10-12. **Basis:** `origin/main` = `5e711d9` (checkout verified current). **Type:** read-only review. No code, migration, pull request or deployment was produced.
**Governing instruction:** Master Directive of 2026-10-11 (read-only review, wait for owner approval).

## 0. Scope, method, limits

- "Current AWS production" is read as the AWS path in the repository: `infra/aws/db/migrations` (0001 to 0048), `apps/sv-api`, `apps/web/src/aws` plus the two shared pages `apps/web/src/pages/service-verification-page.tsx` and `service-verification-reports-page.tsx` that `aws-root.tsx` imports.
- "Legacy" is read as the Supabase build: `supabase/migrations`, `apps/web/src/pages/*`, `apps/web/src/components/*`, `apps/web/src/lib/*`, `packages/shared/src/authorizations.ts`. The AWS root imports none of the legacy scheduler, authorizations or dashboard pages (`aws-root.tsx` import list).
- **What is deployed is not established by this review.** Unable to verify from repository evidence. Owner-reported (not independently verified): production ledger at `46|0046`; 0047 and 0048 decided, not deployed (`docs/releases/DEPLOYMENT_CHECKPOINT_0047_0048.md`). Whether readiness enforcement is active in production: Unable to verify from repository evidence.
- **Which hostname serves which build** (the directive's "legacy app.ogevia.com interface"): Unable to verify from repository evidence. `docs/OGEVIA_OPERATING_RECORD.md` says `app.ogevia.com` is Cognito; `docs/product/FEATURE_RECOVERY_INVENTORY.md` says the Supabase build was production on Netlify. These conflict. The operating record also cites `supabase/migrations/...` files as evidence for AWS features, so it is the weaker source. Migrations and code outrank it.
- **No test was executed in this session.** Test names below were read from test files. Database tests need a PostgreSQL instance. A test listed as "exists" is not a PASS.
- Every statement carries a reference. Where none could be found it says so.

---

# 1. Production Feature Inventory (AWS)

Status: **I** implemented, **P** partial, **M** missing, **U** unknown. "Implemented" means code exists in the repository; it does not mean deployed.

## 1.1 Scheduling

| Capability | Status | Evidence |
|---|---|---|
| One-time shift with caregiver or open | I | `ogevia_api.create_shift`, latest in `0042_readiness_gate.sql:372`; route `POST /v1/shifts` `routes.ts:659` |
| Shift length bounds 15 min to 24 h; no past shifts | I | `0042:372` (checks `v_minutes < 15 or > 1440`, `v_ends <= now()`) |
| Agency-timezone local times; DST nonexistent / repeated hour refused | I | `0035_dst_local_times.sql` (`require_clear_local_times`); `organizations.timezone` read in `create_shift` |
| Caregiver overlap blocked | I | `check_shift_caregiver` (0042:329-360); advisory lock `series_lock` `0034:269` |
| **Client** overlap blocked | M | No such check in `create_shift`, `series_evaluate` or `check_shift_caregiver`. `SCHEDULING_AND_ACCOUNTS_DECISIONS.md` lists "client overlap check" as future work |
| Minimum shift length beyond 15 min | M | Same document lists "minimum shift" as future work |
| Call-out, replacement, cancel with reason, history | I | 0026 (`record_shift_callout`, `assign_shift_caregiver`, `cancel_shift`, `shift_coverage_events`) |
| Caregiver self call-out | I | `call_out_my_shift` 0026:291; route `POST /v1/my-shifts/{shiftId}/callout` |
| Different start/end per weekday in one series | **M** | `shift_series` and `create_shift_series` carry one `start_time` / `end_time` and one `weekdays[]` (`0034:365`, `routes.ts:707`) |
| Schedule page UI | I | `apps/web/src/aws/schedule-page.tsx` (week view, "Needs coverage" filter only, `schedule-page.tsx:280-327`) |

## 1.2 Recurrence

| Capability | Status | Evidence |
|---|---|---|
| Weekly series, occurrences generated from the real calendar in agency timezone | I | `series_occurrences` 0034:109; test "a month with five Mondays has five Monday occurrences" `shift-series.db.test.ts:54` |
| Full preview, evaluated chronologically, per-date outcome | I | `series_evaluate` (latest `0042:858`); `GET /v1/shift-series/preview` `routes.ts:679`; `recurring-schedule.tsx:83` |
| Outcomes: `ok`, `exceeds_authorization`, `no_authorization`, `caregiver_conflict`, `already_started`, `time_does_not_exist`, `time_occurs_twice`, readiness codes | I | `0042:858-945` |
| Nothing shortened, cancelled or moved silently; creation refused while anything is flagged | I | `series_materialize` 0034:290 (`p_on_conflict <> 'skip_flagged'` raises `OGC09`) |
| Skipped dates recorded with reason and minutes | I | `shift_series_skipped_dates` 0034:82, written in `series_materialize` |
| Administrator chooses to skip flagged dates | P | Button "Create and skip the N listed dates" `recurring-schedule.tsx:197`. A single click is the acknowledgement. No separate acknowledgement step, no per-date confirmation |
| Generation horizon | P | Through the end of the second month after the start; `extend_shift_series` adds months (`series_validate` 0034:211) |
| This occurrence / this and future / end series / extend | I | `reschedule_shift`, `change_shift_series_from`, `end_shift_series`, `extend_shift_series` (0034) |

## 1.3 Authorizations

| Capability | Status | Evidence |
|---|---|---|
| Versioned authorizations, lineage, one current per coverage, immutable versions | I | `0004_authorizations.sql` (exclusion constraint, `lineage_id`, guard triggers) |
| Cap is a **monthly** integer-minute cap per calendar month | I | `monthly_authorized_minutes` 0004; month windows via `date_trunc('month', …)` in `authorization_month_usage` / `authorization_month_reserved` |
| Concurrency-safe: advisory lock per lineage | I | `lock_authorization_lineage` 0004:166; tests `shifts.db.test.ts:62`, `shift-series.db.test.ts:181`, `authorization.db.test.ts:344,380` |
| Reserve at schedule time; release on cancel / series change / signed visit | I | `authorization_reservations`; releases at `0026:395`, `0034:444`, `0013:284` |
| Amendment with affected-visit report | I | `amend_client_authorization` 0006:894; route `routes.ts:448`; UI `client-detail-page.tsx:218,284` |
| Amendment reports affected **shifts / reservations** | **M** | Function returns `affected_visit_*` columns only (0006:894ff). Not found for shifts: Unable to verify beyond the return columns |
| Whole-period cap | M | Open question in `SCHEDULING_AND_ACCOUNTS_DECISIONS.md` item 3 |
| Carry-forward of unused hours | M (by design) | No code carries hours across months |
| Expiry on a date with no covering current authorization | I | Scheduling refuses (`create_shift`: "No current authorization covers…"); series flags `no_authorization` |
| Authorization list / usage statuses / expiry warnings page | **M** | Legacy only (`pages/authorizations-page.tsx`, `packages/shared/src/authorizations.ts`). `PENDING_RESTORATION.md` row "Authorizations page": "Pending restoration" |

## 1.4 Dashboard

| Capability | Status | Evidence |
|---|---|---|
| Home: Action-needed banner, month hours by service, financial cards for Administrator | I | `apps/web/src/aws/home-page.tsx`; `GET /v1/reports/utilisation` → `get_utilisation_overview` 0020:240 |
| Authorized / worked / billable / in review / approved / scheduled ahead / hours left, by service | I | `get_utilisation_overview` columns |
| Active clients, active caregivers, coverage rate, open hours, assigned hours, cancellations, conflicts | **M** | No AWS component or function computes them. Legacy `components/operational-snapshot.tsx`, `client-operations-dashboard.tsx` exist but are not imported by `aws-root.tsx` |
| Month selector uses the **agency** timezone | **No** | `home-page.tsx:8` builds the month from the browser clock (`new Date()`), not `organizations.timezone` |

## 1.5 Action Needed

| Capability | Status | Evidence |
|---|---|---|
| Single source: `GET /v1/attention` → `get_attention_summary` | I | latest `0036_signature_recovery.sql:1287`; `action-needed.ts` |
| Reminders shown, not counted (waiting for signature, documents expiring) | I | `action-needed.ts` `reminders()` |
| Drill-down for every count | P | Links exist (`action-needed.ts`), but "Missing Clock-Out", "Awaiting Confirmation", "Visits to Review" all link to the same exceptions view, not a filtered list. Whether the destination list is filtered to the category: Unable to verify from repository evidence |

## 1.6 Reporting and unfilled shifts

| Capability | Status | Evidence |
|---|---|---|
| Report views: overview, caregiver, calendar, reconciliation, corrections, visits, exceptions, staff-access; CSV export | I | `service-verification-reports-page.tsx:106,181` |
| Unfilled shift report (any of the required filters, chart, table, CSV) | **M** | No such view. `GET /v1/shifts` takes only `from`, `to`, `clientId` (`routes.ts:648-657`; `list_shifts` 0047). The only filter is the "Needs coverage" checkbox, one week at a time (`schedule-page.tsx:295`) |
| Coverage forecast | M | Not found |

## 1.7 Availability, matching, care requests

| Capability | Status | Evidence |
|---|---|---|
| Caregiver availability as request → administrator approval; overnight; date exceptions | I | 0037, 0039; routes `routes.ts:2054-2170` |
| Readiness gate (availability, approved service, CPR/TB, client requirements) on every commit path | I | 0042 `assert_ready_for_work`, `readiness_checks` (latest 0047) |
| Enforcement | I (**off by default; per-agency switch**) | `activate_readiness_enforcement` 0042:1148; `ENFORCEMENT_ACTIVATION.md`. Current production state: Unable to verify |
| Override of No Match, Administrator only | I (0042); **one shift, one use in 0047, not deployed** | `0047_availability_override_one_shift.sql` header |
| Explainable matching (provisional score) | I | 0043 `match_caregivers`, `match_caregivers_for_request` |
| Care requests: public portal, offers, assignment, reservations | I | 0011, 0012, 0045; routes `routes.ts:1818-2050` |

## 1.8 Visits and billing-related reporting

| Capability | Status | Evidence |
|---|---|---|
| Visit start/end/confirm, server timestamps, corrections append-only | I | 0005, 0006, 0018; `routes.ts:1050-1220` |
| Late-confirmation recovery and review decisions | I | 0031, 0036 |
| Billing review, human billing approval, void, rounding | I | 0007, 0019, 0029, 0030; `routes.ts:1304-1590` |
| Payer submission ledger ("mark as submitted") | **M** | Supabase only; `FEATURE_RECOVERY_INVENTORY.md` ("Not migrated") |
| Monthly service summary and approval summary reports | I | `list_monthly_service_summary` 0036:~866; `list_monthly_approval_summary` 0030:389 |

---

# 2. Legacy vs Production Comparison (scheduling-related)

| Feature | Legacy (Supabase build) | Current production (AWS build) | Difference | Regression risk if legacy is restored |
|---|---|---|---|---|
| Recurrence engine | Browser generates dates (`lib/recurring-shifts.ts`, `MAX_RECURRING_OCCURRENCES = 52`) and inserts shift rows one by one (`pages/schedule-page.tsx:284-350`) | Server generates occurrences in PostgreSQL in agency timezone; `shift_series` row; preview endpoint | Legacy dates come from the **browser** calendar (its own comment: browser-local weekday math). AWS uses agency timezone and DST rules | Wrong date near midnight / DST; no series identity, so no "this and future" |
| Authorization check on shift insert | Trigger `validate_shift_authorization` per row (`20260818020000_…`); pre-version, picks latest period | Lineage-aware, minute-exact, advisory-locked; usage + reservations | AWS counts reservations and amendments across the lineage; legacy sums by period and has no reservation table | Over-allocation after an amendment (defect M-1 in `0004` header) |
| Over-limit recurrence | Each row inserted independently; failure per row (`schedule-page.tsx:350` comment: server triggers "sole authority") | Whole preview first; refuses all unless skip chosen; skipped dates stored | AWS already matches the owner policy; legacy does not preview authorization at all | Partial series saved with no record of what was not saved |
| Authorization usage display | `list_client_authorizations`: used (completed shifts) + scheduled (scheduled shifts), client-side status: normal / approaching (≥90%) / at limit / over; expiring ≤30 days (`packages/shared/src/authorizations.ts:43-80`) | `list_monthly_service_summary` / `get_utilisation_overview` (billable minutes + reserved) in SQL; no status badges | **Different thresholds (90% vs the owner's 80%/95%) and different inputs (shift hours vs billable visit minutes)** | Two definitions of "used" |
| Authorizations page | Full page (`pages/authorizations-page.tsx`) | None | Monitor does not exist in AWS | Restoring it would resurrect the legacy calculation |
| Action Center | `components/action-center.tsx` (514 lines), `operational-snapshot.tsx` | `action-needed.ts` + `get_attention_summary` | Different categories; AWS total counts "Ready for Approval" in the web but SQL `total` does not (see §3) | Duplicate counting, informational noise |
| Dashboard | `client-operations-dashboard.tsx` + `lib/client-operations.ts` (client-side `ServiceHealth`, `utilizationPercent`, projected hours; a search for week-count constants such as 4 or 4.33 found none) | `home-page.tsx` (hours by service) | Legacy has per-client delivered/remaining/projected, "behind / on-track" health; AWS has none | Client-side calculation of authorization state |
| Matching score | Four CareScore versions (`PENDING_RESTORATION.md` §2) | Explainable provisional score (0043) | Different formula; AWS is eligibility-first | Silent change to who is offered shifts |
| Labels | "Fixed weekly" (`pages/schedule-page.tsx:712`), "On these days" (`:857`), "Schedule shifts" (`:905`) | "Repeat weekly", "Manage repeating shifts", "Repeats every", "Preview dates and hours" (`aws/schedule-page.tsx:316-317`, `recurring-schedule.tsx:152,180`) | **The owner's "before" labels exist only in the legacy page.** "Create Assignment": not found as exact text in either build | Editing the wrong file changes the legacy screen and nothing in production |
| Availability | Weekly windows unioned with date windows; direct save wiped exceptions | Request/approval, replace-not-union (`caregiver-readiness/README.md` "Defects found") | Behavioural fix | Wiped exceptions |
| Call-out | Reassign; replacement texts on call-out | Call-out without texts; replacement by staff | Texts removed pending PHI decision (`PENDING_RESTORATION.md`) | PHI in SMS |

Regression guard found in the repository: none specific. A guard is proposed in §10 (test 20).

---

# 3. Gap Analysis

Authoritative requirement → current state → gap → risk → proposed solution. Solutions are proposals only.

| # | Requirement | Current state | Gap | Risk | Proposed solution |
|---|---|---|---|---|---|
| 1 | Scheduling redesign: multi-day recurring | Weekly series, one time range for all days | Different hours by weekday not supported (one `start_time`/`end_time`) | Admin must create several series | Series with a per-weekday time list (new child rows), preserving existing series |
| 1b | Pre-save authorization visibility for a **single** shift | Remaining shown only **after** save (`schedule-page.tsx:101`); refusal text only after submit | No pre-save panel for one-time shifts | High: owner rule "do not wait for post-save errors" | Read-only preview function, same lock-free calculation, shown on the form |
| 1c | Client overlap | Missing | Double-booked client undetected | Medium | Additive check in the shared shift validation |
| 2 | Monthly enforcement | Calendar-month cap, enforced under lock, tested | Calendar month vs authorization **period** boundaries: authorization months are calendar months regardless of `period_start` day | Medium, **owner confirmation needed** | Keep; document; owner confirms calendar-month meaning |
| 2b | Corrections affecting balance | Rounding adjustments and accepted late-confirmation minutes counted in usage (`0036:829`) | **Possible double count** (below, finding F1) | High (financial) | Reproduce with a test first |
| 2c | No hours carried; expired not renewed; no auto-shortening | Verified by absence of code and by series policy | None | Low | Add tests that pin it |
| 3 | Authorization monitor | None in AWS | Whole feature | Medium | §6 design |
| 4 | Action Needed redesign | Eight categories; unfilled shifts counted regardless of urgency; "Ready for Approval" counted in web only | See §8 | Medium | §8 matrix |
| 5 | Unfilled shift report | None | Whole feature; `list_shifts` has no filters | Medium | New read function + view + CSV |
| 6 | Dashboard / KPI | Hours by service only | KPI dictionary absent; most KPIs unsourced | Medium | §9 |
| 7 | UI simplification | Helper paragraphs exist (e.g. `home-page.tsx` "Utilization = worked hours ÷ …", "One visit can appear in more than one count") | Full screen audit not yet done | Low | Audit table in §4 is a first pass only |
| 8 | Data integrity / security | Tenant isolation, role checks, audit, DST handled; tests listed in §10 | Month selector uses browser clock | Low | Use agency timezone |
| 9 | Acceptance tests | 20 required; coverage in §10 | Several missing | Medium | §10 |
| 10 | Deliverables | This document | Items 4, 7 depend on owner decisions | | |

## Findings that need attention before any plan

- **F1. Possible double count of accepted late-confirmation minutes (INFERRED, not reproduced).** `authorization_month_usage` (0036:829) adds `accepted_minutes` for visits in `administrator_review` with an active `accept_late_confirmation` decision. The reservation of the linked shift is released only when the visit becomes `signed` (`0013:284-323`; the trigger fires `when new.status = 'signed'`). `0031` and `0036` contain no other release (the only reservation reference in 0036 is a read at line 953). If an accepted visit stays in `administrator_review` and had a linked shift, the same minutes would be counted in usage **and** in reservations. This is the exact failure the directive prohibits ("Count completed and reserved hours twice"). Needs a failing test before any claim.
- **F2. Two totals for Action Needed.** SQL `total` (0036:~1352) = missing out + not confirmed + needs review + late responses + uncovered + documents; it **excludes** ready-unapproved. The web total adds `readyForApproval` (`action-needed.ts`, `actionNeededTotal`). The badge and Home use the web sum. SQL `total` is unused by the web (`aws-workspace.ts:61` only declares it).
- **F3. UI statement contradicts the query.** Home says "One visit can appear in more than one count." The five visit counts in `get_attention_summary` filter on mutually exclusive statuses (`draft`, `awaiting_signature`, `administrator_review` with disjoint recovery states, `signed`). Read as exclusive by code; no test was run.
- **F4. "Unfilled Shifts" counts every upcoming shift needing coverage** (`0036:1353-1360`, `ends_at > now()` with no urgency window). Owner rules exclude non-urgent open shifts.
- **F5. Several authorization calculations exist** (§5). Not one function.
- **F6. `scheduled` in the dashboard (`get_utilisation_overview`) is computed from shifts with `starts_at >= now()`** (0020:~270), while `remaining` uses **reservations** (0036:956). A shift that began earlier today with no visit yet is reserved but absent from "scheduled ahead". Inferred from the queries; not tested.
- **F7. Browser-clock month on Home** (`home-page.tsx:8`).
- **F8. Authorization amendment does not report affected shifts/reservations** (0006:894ff returns visits only). A retroactive decrease can leave reservations above the new cap with no flag. Inferred from return columns; the function body was not fully traced.

---

# 4. Unified UI layout (proposed, not built)

Rule: one calculation source, five questions on Home, authorization visible at the point of decision.

**Home (administrator / manager)**

```
[ Month ▾ (agency time) ]                         [ Action needed: N ]
1 Who needs care and when     Today / next 7 days: scheduled hours, open hours   → Schedule
2 Shifts needing coverage     Urgent count + link                                → Unfilled shifts
3 Clients near limits         Near Limit / Critical / Expiring counts            → Authorization monitor
4 Action needed               Counted items only (no reminders)                  → each category list
5 Agency performance          Operations KPIs from the KPI dictionary           → drill-down per KPI
```

**Schedule form (shift and repeat):** inline panel under client + service + date: Authorized / Used / Reserved / Remaining / This shift / Projected remaining; warning line when ≥ threshold; blocked line when over. Repeat: month-by-month table of dates marked **Authorized** or **Excluded** with reason.

**Reports menu:** add "Unfilled shifts" and "Authorization monitor" beside the existing report views (`nav-model.ts`, REPORTS group).

**Naming (owner examples applied only where the AWS text differs):**

| Current AWS text | Owner target | Note |
|---|---|---|
| "Repeat weekly" / "Repeats every" (`recurring-schedule.tsx:152`) | "Recurring" / "Repeat On" | Pending owner confirmation of where each applies |
| Shift form submit (`schedule-page.tsx`, button text not read) | "Save Schedule" | Unable to verify current text from this review |
| "Fixed weekly", "On these days", "Schedule shifts" | n/a | Legacy page only |

First-pass instructional-text candidates (not a full audit): `home-page.tsx` utilization sentence, "The total adds up…" sentence, per-category hint lines in `action-needed.ts`, the skip explanation at `recurring-schedule.tsx:187`. **A full screen-by-screen audit has not been done** and is listed in the implementation plan.

---

# 5. Authorization calculation: dependency map and single-source design

## 5.1 Every calculation site found

| Site | What it computes | Location |
|---|---|---|
| `ogevia.authorization_month_usage` | Used = visit billable minutes + rounding adjustments + accepted late minutes, per lineage-month | latest `0036:829` (earlier definitions 0005:328, 0029:189) |
| `ogevia.authorization_month_reserved` | Reserved = unreleased reservations, per lineage-month | `0026:54` |
| `ogevia.care_request_reserved_usage` | Reserved excluding one request | `0011` (not read in full) |
| `create_shift` | used + reserved + new ≤ cap | `0042:372` |
| `reschedule_shift` | Same, for a move | `0042:462` |
| `series_evaluate` | Same per occurrence, with a running tally and exclusions | `0042:858` |
| `assign_care_request`, `create_assignment` | Assignment cap using usage + request reservations | `0042:601,645`; `0011` line 410 and `0042:622` (`v_used`) |
| `start_ad_hoc_service_visit`, confirm, correction, close-missed | Visit capping at confirmation | `0006:96,204,586,817`; `0014:199`; `0015:148`; `0018:121`; `0036:789` |
| Outage visit records | Cap check | `0028:189` |
| Billing rounding | Room under the cap | `0029:381` |
| `list_monthly_service_summary` | Authorized, worked, billable, **its own** remaining formula | `0036:~866-1000` (does **not** call `authorization_month_usage`) |
| `get_utilisation_overview` | Aggregates the summary; its own `scheduled` from shifts | `0020:240` |
| Web display arithmetic | `availableAfter = authorized - used - reserved - fitsMinutes` | `recurring-format.ts:74` |
| Legacy | `getAuthorizationUsageStatus`, `getAuthorizationExpiryStatus`, `lib/client-operations.ts` | `packages/shared/src/authorizations.ts:50,72`; `pages/authorizations-page.tsx` |

## 5.2 Duplicates identified

1. `list_monthly_service_summary` recomputes billable + adjustments + accepted-late separately from `authorization_month_usage` (two SQL statements that must agree).
2. `get_utilisation_overview` `scheduled` (from shifts) vs reservation-based reserved (F6).
3. The web recomputes remaining after a preview (`recurring-format.ts:74`).
4. Legacy thresholds (90%, 30 days) vs owner thresholds (80%, 95%).

## 5.3 Single authoritative service (design)

One SQL function `ogevia.authorization_balance(lineage_id, month, exclude_visit_id, exclude_series, exclude_from)` returning, in integer minutes: `authorized`, `used` (the current `authorization_month_usage` body), `reserved` (the current `authorization_month_reserved` body, with series exclusion), `remaining = authorized - used - reserved`, `period_start`, `period_end`, `expired`. Then:

- `create_shift`, `reschedule_shift`, `series_evaluate`, assignment paths, visit capping, `list_monthly_service_summary`, `get_utilisation_overview`, and the new preview endpoint, monitor and report call it.
- The web never calculates a balance; it displays server values.
- Migration is behaviour-preserving: first write characterization tests that capture today's outputs for the same fixtures, then switch consumers one at a time.
- Percent thresholds live in one place (organization setting, §6).

Rule for "no double count": a minute is in exactly one bucket: **used** (a counted visit) or **reserved** (an unreleased reservation of a shift with no counted visit). F1 must be resolved to make that rule hold.

---

# 6. Authorization monitor design (do not implement)

One row per client, service, authorization lineage and calendar month.

| Column | Source |
|---|---|
| Client (code; name only with `clients.names.read`) | `list_shifts` pattern 0034:800 |
| Service | `services` |
| Authorization period | `client_authorizations.period_start/end` |
| Authorized hours | `authorization_balance.authorized` |
| Consumed | `.used` |
| Reserved | `.reserved` |
| Remaining | `.remaining` |
| Utilization % | `(used + reserved) / authorized` (definition below) |
| Expiration date | `period_end` |
| Status | rule below |

**Status rules (evaluated in this order; one status per row):**

1. No Authorization: client active with a scheduled shift or visit in the month and no covering current authorization (needs a defined test; see decision gate D3).
2. Expired: `period_end` earlier than the report date and activity or schedule exists.
3. Pending Correction: **not definable from repository evidence.** No data field means "pending correction" for an authorization. Decision gate D4.
4. Expiring Soon: `period_end` within N days (N unset; legacy used 30, decision gate D5).
5. Critical: utilization ≥ 95%.
6. Near Limit: utilization ≥ 80% and < 95%.
7. Healthy: otherwise.

Thresholds are warnings only. They never block anything. Blocking stays where it is today: used + reserved + new > cap, refused in `create_shift` / `series_evaluate` etc.

**Configuration:** two percent values per agency, default 80 and 95, in a new organization-settings table (additive). Role: owner edits; manager reads.

**Utilization definition (needs owner confirmation, D2):** committed (used + reserved) vs worked. Legacy used committed hours (`getAuthorizationUsageStatus`); the AWS Home card uses worked ÷ authorized (`home-page.tsx` text). Recommendation: committed, because the block rule is committed.

---

# 7. Scheduling-time warning design (do not implement)

Panel shown under client + service + date, before Save. Same server function as the monitor, read-only, no lock.

```
Authorized: 60h        Used: 48h        Reserved: 6h
Remaining: 6h          Requested shift: 4h
Projected remaining: 2h            [Near Limit]
```

| Situation | Behaviour |
|---|---|
| Projected remaining ≥ 0 and utilization after the shift below 80% | No warning |
| After the shift ≥ 80% / ≥ 95% | Amber / red line; Save enabled |
| Projected remaining < 0 | Blocking message with exact shortfall (`format_duration`, 0032); Save disabled |
| No covering authorization | Blocking message; Save disabled |
| Expiring soon | Info line |

Multi-month shift (overnight across month end): the reservation uses the start date's month (`create_shift` inserts `service_date = p_local_date`). Behaviour for a shift that crosses midnight at month end is a decision gate D6.

The preview is advisory. The save path still re-checks under the lineage lock, so a concurrent request can change the answer between preview and save. The UI must handle that refusal (it already does for the post-save error).

**Recurring preview:** keep the existing month tables (`recurring-schedule.tsx:25-37`), add per-date label **Authorized** / **Excluded**, list excluded dates with reasons, add an explicit acknowledgement checkbox ("I understand N dates will not be scheduled") before "Save Schedule", and keep the server writing `shift_series_skipped_dates`. Mapping to the owner policy:

| Owner step | Today |
|---|---|
| 1 Full preview | Present |
| 2 Chronological evaluation | Present (`series_evaluate` order and tally) |
| 3 Mark Authorized / Excluded | Present as `ok` / other outcomes; wording differs, and excluded reasons include non-authorization causes |
| 4 Display excluded dates | Present |
| 5 Administrator acknowledgement | Partial (button click only) |
| 6 Save only authorized | Present (`skip_flagged`) |
| 7 Record planning exceptions | Present (`shift_series_skipped_dates`) |

Decision gate D7: whether a date excluded for a **non-authorization** reason (caregiver conflict, DST) is also a "planning exception" or only authorization exclusions are.

---

# 8. Action Needed classification matrix

Owner include list: overdue clock-outs; signature problems; verification failures; review deadlines exceeded; urgent coverage gaps; expired authorizations impacting care; documentation issues requiring intervention. Exclude: informational notices; future staffing forecasts; non-urgent open shifts; skipped recurrence dates; resolved; completed.

| Current item | Source | Verdict | Reason |
|---|---|---|---|
| Missing Clock-Out | `missing_time_out` | **Keep** | = overdue clock-outs |
| Awaiting Confirmation (ended > 60 min, no confirmation) | `not_confirmed` | **Owner decision D8** | Fits "signature problems" but overlaps the "Waiting for a Signature" reminder |
| Visits to Review | `needs_review` | **Keep, narrow** | "review deadlines exceeded": no review-deadline concept exists in the repository; D9 |
| Signatures to Review | `late_responses` | **Keep** | signature problems |
| Unfilled Shifts | `uncovered_shifts` | **Change** | Count only urgent gaps; urgency window unset (D10). The full list moves to the Unfilled Shift Report |
| Overdue Documents | `documents_blocking` | **Keep** | documentation requiring intervention |
| Documents to Review | `documents_to_review` | **Owner decision D11** | Work for staff, not a problem |
| Ready for Approval | `billing_ready_unapproved` | **Remove from the count** | Workflow queue, not on the include list; counted by web only (F2). Remains on Billing review |
| Waiting for a Signature | reminder | Already excluded | Correct |
| Documents Expiring Soon | reminder | Already excluded | Correct |
| Expired authorization impacting care | none | **Add** | Missing. Definition: expired lineage with a scheduled shift or an open visit in the next N days (D3/D10) |
| Skipped recurrence dates | none | Correctly absent | Stored in `shift_series_skipped_dates`; surface only in schedule and the report |

**Count rules:** one number per category from a single server query; the total is computed in SQL only and the web displays it (removes F2); each count links to a list filtered to exactly the same predicate (shared predicate in SQL, not copied); no visit appears in two categories (add a test asserting disjoint sets).

---

# 9. KPI dictionary

**Common to all KPIs unless stated:** Timezone = `organizations.timezone` (verified in `create_shift`). Reporting period = selected month or date range in that timezone. Shifts are included only if `status = 'scheduled'` or `'completed'`, never `'cancelled'`, unless the KPI says otherwise. All values come from server queries; none is calculated in the browser. A KPI whose source is missing is shown as "Unavailable", never as 0.

Source key: **E** exists in AWS today; **N** needs new read code over existing tables; **X** cannot be supported from current data.

| KPI | Definition and formula | Data source | Inclusions / exclusions | Drill-down target | Src |
|---|---|---|---|---|---|
| Active Clients | Clients with `status = 'active'`, not deleted | `clients` | Excludes inactive, discharged | Clients list filtered active | N |
| Active Caregivers | Caregiver records with `status in ('ready','active')`, not deleted | `caregiver_records` (same set `series_validate` accepts) | Excludes onboarding, inactive | Care team filtered | N |
| Scheduled Hours | Sum of minutes of non-cancelled shifts in period ÷ 60 | `shifts` (not the `starts_at >= now()` form in `get_utilisation_overview`; see F6) | Includes completed; excludes cancelled | Schedule for the period | N |
| Completed Hours | Worked minutes of visits `signed` or `administrator_review` ÷ 60 | `service_visits.worked_minutes` | Excludes draft, voided, corrected | Visit records | E (summary) |
| Open Hours | Minutes of non-cancelled future-or-current shifts with `shift_coverage_state = 'needs_coverage'` | `shifts` | Excludes covered, cancelled | Unfilled report | N |
| Coverage Rate | `(scheduled shift minutes − open shift minutes) / scheduled shift minutes`; shown "Unavailable" when denominator is 0 | `shifts` | Same inclusions as Scheduled Hours | Unfilled report | N |
| Action Count | Total from §8 | `get_attention_summary` | Excludes reminders | Per-category list | E (after change) |
| Utilization | `(used + reserved) / authorized` per §6, aggregated as sum over rows ÷ sum | `authorization_balance` | Rows with authorized > 0 | Monitor | N |
| Near Limits | Rows with utilization ≥ 80% and < 95% (thresholds configurable) | Monitor | Excludes expired / no authorization | Monitor filtered | N |
| Expiring | Rows with `period_end` within N days (D5) | `client_authorizations` | Current versions only | Monitor filtered | N |
| Unused Capacity | `sum(remaining)` hours | `authorization_balance` | Current month; no carry-forward | Monitor | N |
| Discrepancies | **Undefined.** Not found in any document | n/a | | | X until defined (D12) |
| Assigned Hours | Minutes of non-cancelled shifts with a caregiver, per caregiver | `shifts` | Excludes called-out unreplaced (`shift_is_called_out`) | Caregiver schedule | N |
| Available Capacity | Approved availability hours in period − assigned hours, per caregiver | `availability` (0039) − `shifts` | Only caregivers with approved availability; others "Not provided" | Caregiver availability | N (formula needs owner confirmation, D13) |
| Coverage Gaps | Count of open or called-out unreplaced shifts | `shift_coverage_state` | | Unfilled report | N |
| Cancellations | Count of shifts moved to `cancelled` in period, with reason | `shifts.cancel_reason`, `shift_coverage_events` | | Schedule filtered cancelled | N |
| Conflicts | **Not persisted.** Overlaps are refused or flagged at the time (`caregiver_conflict` is computed in `series_evaluate`, not stored; single-shift refusals are errors) | n/a | | | X (would need an event log; D14) |
| Missing Clock-outs | Same predicate as §8 | `get_attention_summary` | | Exceptions list | E |
| Pending Confirmations | Visits `awaiting_signature` | `service_visits` | | Visit records filtered | E |
| Review Queue | Visits `administrator_review` without active decision | `service_visits`, `visit_review_decisions` | | Visit review | E |
| Corrections | Count of corrections in period | `visit_corrections`; route `reports/correction-history` | | Corrections report | E |
| Credentials | Staff documents expired / overdue / expiring | `get_document_alerts` 0033:249 | | Documents | E |
| Verified Billable Hours | Billable minutes of `signed` visits ÷ 60 | `service_visits.billable_minutes` | Excludes review, voided | Billing review | E |
| Estimated Revenue | `billable_minutes/60 × hourly_rate_cents` where the lineage has a rate | `get_utilisation_overview.billable_value_cents` | Excludes lineages without rate (reported separately); Administrator only (`billing.read`) | Billing review | E |
| Unbilled Approved Visits | Approved, not yet submitted | `billing_approvals` + a submission state | **No submission state exists in AWS** (ledger "Not migrated") | | X (D15) |
| Missing Rates | Lineages with `hourly_rate_cents is null` | `lineages_without_rate` | | Client authorizations | E |
| Margin | Requires caregiver pay data | none (`home-page.tsx` states pay data is absent) | | | X |

Rules: no KPI is displayed until its row is approved; X rows stay hidden.

---

# 10. Dashboard drill-down map and acceptance-test coverage

## 10.1 Drill-down map

| Dashboard figure | Target | Exists today |
|---|---|---|
| Action categories | Filtered lists (same predicate as the count) | P: all three visit categories open one exceptions view (`action-needed.ts`) |
| Scheduled / Open hours, Coverage rate, Coverage gaps | Unfilled report, filtered | No |
| Near limits, Expiring, Unused, Utilization | Authorization monitor, filtered | No |
| Completed hours, Pending confirmations, Review queue, Corrections | Visit records / reports | Yes (`?view=visits`, `corrections`) |
| Credentials | Documents | Yes |
| Billable hours, Revenue, Missing rates | Billing review / client authorizations | Yes / Yes |
| Active clients / caregivers | Clients, Care team | Yes (lists exist; filter parameters not verified) |

Requirement: each count equals the number of rows in its target list, enforced by a test that queries both.

## 10.2 Required acceptance tests: existing coverage (names read, none executed)

| # | Required test | Existing test | Verdict |
|---|---|---|---|
| 1 | Multi-day recurring | `shift-series.db.test.ts:75` (Mon–Thu 2 h) | Exists |
| 2 | Different hours by weekday | none; feature missing | **Missing** |
| 3 | Four-week month | not found by name | Unable to verify |
| 4 | Five-week month | `shift-series.db.test.ts:54` | Exists |
| 5 | Authorization reset (new month) | month window by construction; no named test | Unable to verify |
| 6 | Authorization expiration | `shift-series.db.test.ts:101` | Exists |
| 7 | Full utilization | `shifts.db.test.ts:172`, `authorization.db.test.ts:284` | Exists |
| 8 | Over-limit attempt | `shifts.db.test.ts:62`, `shift-series.db.test.ts:75` | Exists |
| 9 | Concurrent requests | `shifts.db.test.ts:62`, `shift-series.db.test.ts:181`, `authorization.db.test.ts:344,380` | Exists |
| 10 | Caregiver conflict | `shifts.db.test.ts:78`, `shift-series.db.test.ts:111` | Exists |
| 11 | Series modification | `shift-series.db.test.ts:123` | Exists |
| 12 | Single occurrence change | same | Exists |
| 13 | Single occurrence cancellation | `shifts.db.test.ts:132` | Exists |
| 14 | Action Needed counts | `action-needed.test.ts` (web arithmetic only); SQL counts: Unable to verify | Partial |
| 15 | Unfilled report filters | none | Missing |
| 16 | KPI accuracy | none | Missing |
| 17 | Dashboard drill-down accuracy | none | Missing |
| 18 | Tenant isolation | `tenant-assignment-visit.db.test.ts`, `care-token-security.db.test.ts`, `access-roles.db.test.ts` | Exists (contents not read in full) |
| 19 | Role isolation | `access-roles.db.test.ts`, `shift-access.db.test.ts` | Exists (not read in full) |
| 20 | Legacy regression protection | none | Missing. Proposed: a test that fails if `aws-root.tsx` (transitively) imports `pages/schedule-page`, `pages/authorizations-page`, `components/action-center` or `lib/client-operations`, plus a test pinning the AWS labels |

Added by this review: F1 reproduction test; disjoint-counts test for Action Needed; month-boundary test for the preview function; amendment-with-existing-reservations test (F8).

---

# 11. Implementation plan ordered by risk (proposal; nothing authorized)

| Step | Work | Risk | Gate |
|---|---|---|---|
| 0 | Owner answers D1 to D15 | none | Owner |
| 1 | Characterization tests for today's authorization outputs; reproduce F1, F6, F8 as failing or confirming tests | Low (tests only) | Approval of this package |
| 2 | `authorization_balance` function; switch consumers one at a time; F1 fix if confirmed | **Highest** (financial) | Separate approval, tested on a copy |
| 3 | Pre-save preview endpoint + panel for single and recurring shifts; Authorized / Excluded labels; acknowledgement | Medium | |
| 4 | Action Needed changes (§8); remove duplicate totals | Medium (changes a counted number users see) | |
| 5 | Unfilled Shift Report (read functions, filters, chart, table, CSV, drill-down) | Medium | |
| 6 | Authorization monitor + thresholds setting | Medium | |
| 7 | Dashboard sections + approved KPIs only; agency-timezone month | Medium | |
| 8 | Per-weekday series times | Medium-high (touches series model) | Own approval |
| 9 | UI copy simplification across admin screens after a full audit | Low | |

Each step ships as its own additive migration (new files after 0048; applied files are never edited, per `DEPLOYMENT_CHECKPOINT_0047_0048.md`), with a `.down.sql` in `infra/aws/db/rollback`, tests, and a separate deployment approval. All deployments are YELLOW under `CLAUDE.md` §13.

# 12. Rollback strategy

Based on the repository's existing mechanisms (`DEPLOYMENT_CHECKPOINT_0047_0048.md`, `infra/aws/db/rollback/*.down.sql`):

| Layer | Rollback |
|---|---|
| Database | Pre-deployment RDS manual snapshot (rollback anchor); migrations are transactional, one file each; forward fix preferred; classified `.down.sql` per migration. New read-only functions: drop. Replaced functions (for example `get_attention_summary`): the down script restores the previous definition verbatim. No row in an existing table is modified by steps 3 to 7 |
| API | Redeploy the previous commit through the infra step (removes added routes) |
| Web | Redeploy the previous bundle from S3 history |
| Order | Web → API → database (reverse of deployment) |
| Data safety | No step deletes shifts, reservations, visits, approvals or audit rows. Step 2 changes how numbers are computed, not stored values; compare old and new outputs on a restored copy before cutover |
| Stop condition | Any difference between the characterization output and the new balance function on the same data halts the step |

---

# 13. Decision gates (owner)

Recommendations are defaults only; none is applied without approval.

| # | Question | Known | Recommended |
|---|---|---|---|
| D1 | Which hostname serves which build (legacy vs AWS)? | Docs conflict | Owner states it; drives the regression guard |
| D2 | Utilization = committed (used + reserved) or worked? | Block rule uses committed | Committed |
| D3 | "No Authorization" and "expired impacting care": window and trigger | Not defined | Scheduled shift or open visit in the next 7 days |
| D4 | What is "Pending Correction"? | No field | Define as an amendment with unresolved affected visits, after owner confirms |
| D5 | Expiring-soon days | Legacy 30 | 30, configurable |
| D6 | Overnight shift crossing month end: which month is charged? | Start-date month | Keep start date |
| D7 | Are non-authorization exclusions also "planning exceptions"? | All skips stored | Yes, with reason |
| D8 | Keep "Awaiting Confirmation" in Action Needed? | Reminder duplicates it | Keep, remove reminder overlap |
| D9 | Is there a review deadline, and how long? | None in code | Define, or keep all review items |
| D10 | "Urgent" coverage gap window | None | Starts within 48 h |
| D11 | "Documents to Review" counted? | Counted today | Not counted |
| D12 | Meaning of "Discrepancies" | Undefined | Leave hidden |
| D13 | Available Capacity formula | Approved availability exists | Availability hours − assigned hours |
| D14 | Persist scheduling conflicts for the "Conflicts" KPI? | Not stored | No; hide the KPI |
| D15 | "Unbilled Approved Visits" needs a submission state | Ledger not in AWS | Defer |
| D16 | Calendar-month cap vs authorization period | Calendar month | Confirm |

---

# 14. Statement of verification

- **VERIFIED by reading code:** all items cited with a file and line or function.
- **INFERRED:** F1, F6, F8, the mutual exclusivity in F3.
- **NOT VERIFIED:** any test result; deployed state; enforcement activation; hostname-to-build mapping; behaviour of unread functions (`care_request_reserved_usage`, parts of `amend_client_authorization`).
- **Not done, by instruction:** implementation code, migrations, pull requests, deployment, production access.
