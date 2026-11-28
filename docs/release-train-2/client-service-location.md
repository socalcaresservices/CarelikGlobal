# Client profile: service address, county and coordinating office together (migration 0118)

Branch `feature-completion-phase-2`, PR #124 (draft). **Implemented and tested locally; not applied to any database; nothing deployed.** The TEST fix needs your approval for migration 0118 and a TEST deploy of the `serviceLocation` switch (see the end).

## The problem (verified in the code)
A client had **two cities**: `clients.city` (shown as "City" in Details) and the city of the service address (`client_service_zip.city`, what open-shift matching and alerts use), edited in two different places. County and office were two more controls elsewhere. So Details could say "No city" while another card said "Winchester".

## What the profile shows now (switch `serviceLocation`)
One section, **Service location**, with one edit flow:

| Field | Meaning (shown on screen) | Example |
|---|---|---|
| Service address | Where the caregiver goes. Open-shift matching uses this city. City and ZIP are entered once. | Winchester, CA 92596 |
| Service county | Used for county reports and filters. Suggested, then chosen by staff. | Riverside County |
| Coordinating office | Manages the client's shifts and coverage requests. Always an explicit choice. | Temecula |

Summary line: `Winchester, CA 92596 · Riverside County · Temecula office`. Details no longer has a City field (and never says "No city"); its edit form no longer asks for a city or ZIP.

* **One save** (`set_client_service_location`, one transaction, one audit row with no address in it): service address, county, and the coordinating office (the client's primary office; every other office the client already has is kept; a null office leaves it as it is).
* **Source of truth:** the saved service address. `clients.city` is kept in step with it by a trigger so every older screen and report shows the same city. Existing data is preserved: the migration fills a client's **empty** Details city from its service city once, and does **not** overwrite a Details city that differs (the next save of the service location aligns it). Existing counties and office assignments are untouched.
* **County suggestion:** from the agency's own other clients with the same ZIP (the most common county), or from a platform ZIP-to-county reference table that is **empty until the owner approves a dataset with its licence** (no dataset ships with Ogevia; nothing is guessed). It is only a suggestion; authorized staff (`clients.manage`) choose or clear the county.
* **Matching and offices:** open-shift matching uses the service city. The office that handles a request is: the shift's own choice, else the **client's coordinating office** (new), else the agency's only office, else the sender chooses. So the Winchester client coordinated by Temecula needs no per-shift office.
* **Incomplete address:** the section says exactly what is missing ("The service address is missing the ZIP code. Open shifts for this client cannot be sent to caregivers until it is complete.") with a button; the open-shift alert's block links straight to the edit form (`/clients/{id}?edit=location#service-location`).
* State "CA" is shown because service counties are California-only (0111); there is no stored state.

## Evidence (local; synthetic data)
* DB `client-service-location-0118.db.test.ts` (8), HTTP `client-service-location-api-0118.db.test.ts` (2), web `service-location.test.tsx` (7), CDK switch test (+1), tenant-isolation sweeps extended, ledger rehearsal for 0118 (apply, verify, rollback), 0117/0113 suites re-run green.
* **Browser (17 checks, local harness, client "Demo Today A" built to reproduce the confusing state: Details city empty, service address Winchester 92596, no county, no office):** `docs/release-train-2/service-location-browser-evidence/` (`run-service-location-pass.sh`). Covers the before and after summary lines, Details without "No city", the county suggestion and the explicit office, persistence after reload, saving Details without a city, the alert subject `Open shift in Winchester` with `Coordinating office: Temecula` and the board line `Winchester · Coordinated by Temecula` with no shift-level office, a client with a city but no ZIP (exact missing message, link opens the form, refusal message, then completion). The run found and fixed one bug: saving from the link re-opened the form.
* **Not verified:** TEST or production; real address verification (there is none: the ZIP/city are staff-entered); county data from a reference list.

## To put it in TEST (needs your approval; nothing run)
1. Migration 0118 (`TEST_PENDING_LEDGER.sh` accepts it; needs 0111, 0113 and 0117 in the ledger). Rollback `rollback/0118_client_service_location.down.sql` keeps all stored values.
2. Switch `features.serviceLocation` (2 routes, `SERVICE_LOCATION=on` on the API function; needs the offices and county switches, which are ON in TEST). Add it to the next TEST stage script and gate (the stage 2 script is not yet written).
3. Browser check in TEST with "Demo Today A": the profile shows `Winchester, CA 92596 · Riverside County · Temecula office`, Details no longer says "No city", and the incomplete case links to the form.
