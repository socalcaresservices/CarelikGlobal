# Offices, service counties and Caregiver Color (migration 0111)

**Status: IMPLEMENTED and TESTED on the local harness. NOT deployed to TEST. NOT deployed to production.** Production waits for the owner's explicit GO.

## What the owner asked for
1. Assign clients and caregivers to offices (zero, one or many; one primary) and filter by office and county.
2. Caregiver Color: add Red, Yellow, Blue and show the colour wherever admins use it.

## What the inspection found (VERIFIED in the repository)
| Question | Finding |
|---|---|
| Is there an existing "Dashboard Chart Color" caregiver field? | **No.** The only colour settings are the per-user dashboard palette, service colours and the agency accent. Caregiver Color is therefore a **new** field (`caregiver_records.profile_color`), not an extension of an old one. |
| Are there county fields? | **No.** Clients and caregivers only have city/ZIP (used for caregiver matching). Service County (clients) and Service Counties (caregivers) are new and independent of address, ZIP, availability and office. |
| Offices | Already live in production (0110, one responsible office per client). 0111 extends them; nothing in 0110 is replaced. `clients.responsible_office_id` is kept and always equals the client's primary office, so Billing review and Reports keep working. |
| Palette | Red, Yellow, Blue (requested) plus Green, Purple, Orange, Teal, Gray (**assumption** — the owner did not name the others; saved colours are never changed). |

## What changed
- **Database (0111, additive):** `office_assignments` (many per person, exactly one primary, enforced by a deferred database constraint), office address/city/ZIP/county, `clients.service_county`, `caregiver_service_counties`, `caregiver_records.profile_color`, the 58-county California list, functions to update/reactivate offices, set a person's offices, counties and colour, and one `list_people_facets` read. Existing 0110 office assignments are copied in as primary assignments. Nothing is guessed from an address, ZIP or county.
- **API (8 routes, new switch `officeAssignments`):** `POST /v1/offices/{id}/update|reactivate`, `GET /v1/people-facets`, `POST /v1/clients/{id}/offices|service-county`, `POST /v1/caregivers/{id}/offices|service-counties|color`. Routes behind a switch do not exist while the switch is off.
- **Web:** Settings → Offices (add with address/county, Edit, Retire, Reactivate, client/caregiver counts); Assigned Offices (Primary first, Additional, Make primary, Remove) on client Details and the caregiver profile; Service County (client) and Service Counties (caregiver); Caregiver Color picker (labelled "Caregiver Color", yellow outlined); Office and County filters and a compact Offices column on Clients and Caregivers (Care Team) lists; Office filter on Billing review and Reports now matches any assigned office; swatch beside the caregiver name on the profile, the Care Team list, schedule shifts and the Reports chart "Group by Caregiver" (the existing accessible chart that shows individual caregivers; no new chart was added).
- **Who sees what:** Offices settings: agency Administrator (organization.update). Client offices/county: clients.manage. Caregiver offices/counties/colour: caregivers.manage. Read-only display: anyone who can open those lists (clients.names.read, caregivers.manage, visits.manage, shifts.manage, billing.read). Caregivers (the sign-in role) see none of it. Offices, counties and colours are for identification and filtering only: they restrict no access and change no schedule, authorization or hour.
- Existing records: every existing client keeps the office it had in 0110 (as primary); everyone else is **Unassigned**; all counties and colours start empty.

## Evidence (local harness, synthetic data)
- Database: `infra/aws/db/test/offices-0111.db.test.ts` (14 tests incl. backfill, primary guard, inactive offices, cross-org refusal, audit, rollback, county list equals the web list); apply → rollback → apply verified.
- API: `apps/sv-api/test/office-assignments.db.test.ts` (3) and the tenant-isolation sweep (9, covers all 8 new routes); CDK switch test (5).
- Web: `office-assignments.test.tsx` (6), `offices.test.tsx` (12), full web suite 1411 passed; lint and typecheck clean.
- Browser: `browser-checks/office-assignments-checks.mjs` — ALL PASSED (offices with address/county, assign/primary change/persist after refresh, caregiver with two offices found by either filter and once under All Offices, two service counties, Office+County+status+search combine, office address move keeps assignments, retire keeps links and blocks new assignments, reactivate, red/yellow/blue save and persist, swatches on profile/list/schedule/Reports chart, caregiver login sees no office controls). Yellow swatch computed style: fill rgb(250,204,21), 2px border rgb(133,77,14).
- NOT YET VERIFIED: TEST environment, production, and a physical phone. The TEST report follows the TEST rollout.

## Production rollout (after TEST and the owner's explicit GO)
Same method as the 0110 release: temporary admin-host attach with automatic restore; logical backup first; one-transaction migration guarded to the exact ledger; code-only change set, then routes-only change set; route smoke checks with automatic route rollback; web publish. Blocks are provided one at a time, only when CI is green on the exact commit.

## Rollback
1. **Routes / code:** remove the `officeAssignments` routes (switch off) and redeploy the previous handler; the old 0110 routes keep working because the old `set_client_office` still exists as a wrapper.
2. **Database:** `infra/aws/db/pending/rollback/0111_office_assignments_counties_colors.down.sql` restores the 0110 functions and drops the new tables and columns; `clients.responsible_office_id` (the primary office) is kept, so the 0110 behaviour is unchanged. Office addresses/counties, secondary assignments, service counties and colours entered after the release are lost on rollback — take the logical backup first.
3. **Web:** republish the previous web build.

## Records needing manual assignment (to flag at TEST/production)
Every caregiver, and every client that had no 0110 office, will show **Unassigned** until an administrator assigns an office. Counties and colours are empty everywhere. Nothing is inferred from addresses or ZIP codes.
