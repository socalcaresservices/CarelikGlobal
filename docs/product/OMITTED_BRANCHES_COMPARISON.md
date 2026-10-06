# Omitted branches: feature comparison with the AWS build

6 October 2026. Read-only comparison of eight Supabase-path branches that are not in `claude/vibrant-sagan-rn9z58` against the AWS code in the same branch. Nothing was merged. I spot-checked the load-bearing claims myself (marked CHECKED); the rest comes from reading the branches and migrations and was not run against a database.

**Why not merge any of them directly:** they change the Supabase app (`apps/web/src/pages`, `supabase/migrations`, browser-side Supabase calls). The AWS build has its own migrations (0001 to 0036), API handlers and pages. Branch #58 contains #53 to #56 stacked inside it, so it is the least suitable.

## Summary

| Feature (branch) | In AWS today | Documented as deferred? | Recommendation |
| --- | --- | --- | --- |
| **Overnight and weekend availability** (#55) | **Gap.** Weekends work (weekday 0 and 6). Overnight does not. | No | **Port now** (small AWS migration). |
| **CareScore, missing-data credit** (#53) | Missing. The AWS matcher is a yes/no filter with no score. | Yes: "NEEDS IMPLEMENTATION in AWS" | Port later, with CareScore. |
| **Caregiver skills** (#54) | Missing (no column, route or field). | Implied (matching is not ported) | Port later, with CareScore. |
| **Caregiver services and preferred cities** (#58) | Services per caregiver exist (0023). **Cities for caregivers: missing.** Matching uses neither. | Staged last in the owner's list | Port later, with CareScore. |
| **Month hours by source** (#56) | Partial. Authorized, scheduled, worked, billable, remaining and approved exist. "Requested" and "projected" do not. | Yes: item 13 "Open" | Do not port the branch. Build pace and projection on the AWS data later. |
| **Incidents, multiple categories** (#57) | No incidents module in AWS. | Yes: "Not migrated" | Do not port. Carry "several categories" into any future design. |
| **Support access workflow** (#43) | Missing. | Yes: "needs a later, explicitly audited design" | Defer. Needs an owner-approved design first (tenant isolation). |
| **Audit docs and Phase 0** (`claude/serene-einstein-1rzi90`) | Superseded by the much larger `docs/aws` and `infra/aws`. | n/a | Do not merge. |

## Availability: what AWS does today (CHECKED)

- Storage: `ogevia.caregiver_availability_windows` has `weekday smallint` (0 = Sunday to 6 = Saturday), `specific_date`, `start_local time`, `end_local time`, with `constraint availability_time check (start_local < end_local)` (`infra/aws/db/migrations/0011_care_requests_availability.sql:51-57`).
- **A window cannot cross midnight.** 22:00 to 06:00 is refused by the database, and the page also blocks it.
- Weekends are simply days 0 and 6. The editor applies one time range to every selected day; the schema would allow different times per day.
- Matching (`list_available_caregivers`, 0011 line 335): a caregiver matches if a window on the request's local date or weekday has `start_local <= request start` and `end_local >= request end`, and they are not marked unavailable that date, not double-booked and not previously declined.
- **Overnight request, read from the code (not run):** the request's end time of day is earlier than its start, so it is compared against a single day's window. It either matches nobody, or matches only someone whose window covers the whole day, without checking the part after midnight. Either way an overnight request is not matched correctly.
- The branch's approach (`supabase/migrations/20260826030000_overnight_availability.sql`) puts windows on a week-minute axis, so Sunday night runs into Monday. It is a usable design reference; its SQL cannot be reused as is.
- **Proposed AWS work (coarse):** one migration to relax `availability_time` and compare on a week-minute range inside `list_available_caregivers`; allow end earlier than start in `replace_my_availability` and in the page; keep the daylight-saving handling from 0035. Tests: a 22:00 to 06:00 window matches a 23:00 to 05:00 request, does not match 07:00 to 09:00, and a weekend overnight window crossing Sunday into Monday works.

## Per-feature notes

- **CareScore (#53).** AWS has no score function or page. `docs/product/PILOT_SCOPE_RECONCILIATION.md:135`: "CareScore and Matching | NEEDS IMPLEMENTATION in AWS" (CHECKED). Weights in the old build (inventory): proximity 30, language 25, availability 12+8, skills 10, history 15. The missing-data rule (a gap earns no credit and is named) belongs inside that port. Not on the visit, reconciliation or billing path, so low pilot risk.
- **Skills (#54).** No skills field in AWS migrations or pages (CHECKED by search: no match). Needed only once CareScore exists.
- **Services and cities (#58).** The AWS Care Team has caregiver services (0023) but no caregiver city (CHECKED: the only AWS `city` column is on clients, 0022). The matcher uses neither. The owner's UX list asks for city and services in matching (`OGEVIA_UX_CHANGE_LIST.md`, item 7).
- **Month hours by source (#56).** AWS Home and the reports cover the real chain (authorized, scheduled, worked, confirmed, billable, remaining). "Requested" and "projected" are new work; `PILOT_SCOPE_RECONCILIATION.md` lists pace and projection as item 13, Open.
- **Incidents (#57).** No tables, routes or pages in AWS (CHECKED: no migration or AWS page mentions incidents). `FEATURE_RECOVERY_INVENTORY.md:42`: "Settings, Access, Incidents | Working | Not migrated" (CHECKED).
- **Support access (#43).** `docs/aws/PHASE_2_POSTGRES_ARCHITECTURE.md` says there is no platform-owner bypass and cross-tenant support access needs a later, audited design. A support feature touches tenant isolation, so it needs your approved design before any code.
- **Audit docs.** Reference reading only (`OGEVIA_FEATURE_RECONCILIATION.md`); the AWS docs already cover the same ground and more.

## What I could not determine

- Whether you want CareScore, incidents or support access in the pilot (documents leave it to you).
- Whether overnight care requests occur in your pilot. If they do, the gap above affects matching today.
- Whether the AWS TEST database behaves as read from the code (no database was run for this comparison).

## Decision for you

Approve or change the overnight work (port now), and confirm CareScore with skills, services and cities as one later AWS build. Everything else is "do not port" or "defer", with reasons above.
