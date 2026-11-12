# Pilot regression run 20261110T235615Z

- Finished (UTC): 2026-11-10T23:57:01+00:00
- Mode: local
- Commit: not given
- Target: {"local": true}
- Result: 35 passed, 0 failed, 1 not run

## Catalog IDs

| ID | Result |
|---|---|
| AUT-01 | PASS |
| DSH-01 | PASS |
| DSH-02 | PASS |
| EVV-01 | PASS |
| EVV-05 | PASS |
| REC-01 | PASS |
| REC-02 | PASS |
| REC-03 | PASS |
| REC-09 | PASS |
| REC-10 | PASS |
| REC-11 | PASS |
| RPT-01 | PASS |
| SCH-01 | PASS |
| SCH-02 | PASS |
| SCH-03 | PASS |
| SCH-04 | PASS |
| SCH-07 | PASS |
| SCH-09 | PASS |
| SCH-10 | PASS |
| SCH-13 | PASS |
| SMK-01 | PASS |
| SMK-04 | PASS |
| SMK-05 | PASS |
| SMK-06 | SKIP |
| USR-01 | PASS |
| USR-02 | PASS |
| VIS-01 | PASS |
| VIS-02 | PASS |
| VIS-04 | PASS |
| VIS-05 | PASS |
| VIS-06 | PASS |
| VIS-08 | PASS |
| VIS-11 | PASS |

## Cases

| IDs | Case | Result | Detail |
|---|---|---|---|
| SMK-01, USR-01 | manager signs in with role manager in exactly one membership of the agency | PASS | status 200 |
| SMK-01, USR-01 | caregiver A signs in with role caregiver in exactly one membership of the agency | PASS | status 200 |
| SMK-01, USR-01 | caregiver B signs in with role caregiver in exactly one membership of the agency | PASS | status 200 |
| USR-01, SCH-13 | caregiver cannot create a shift | PASS | status 403 |
| USR-01, SCH-13 | caregiver cannot list the agency's shifts | PASS | status 200 |
| SMK-04, EVV-05 | caregiver's client list carries codes only (no names, birth dates or payer identifiers) | PASS | status 200 leaked [] |
| USR-02 | another agency's manager cannot list this agency's clients | PASS | status 200 |
| USR-02 | another agency's manager cannot create a shift here | PASS | status 404 |
| USR-02 | another agency's manager cannot list this agency's visits | PASS | status 200 |
| SMK-06 | a call with no sign-in is refused (401) | PASS | status 401 |
| SMK-06 | a token from another issuer is refused (401) | PASS | status 401 |
| SMK-06 | a token for another app client is refused (401) | PASS | status 401 |
| SMK-06 | an expired token is refused (401) | PASS | status 401 |
| SMK-06 | API Gateway authorizer over HTTPS | SKIP | no --api-url given |
| SCH-01 | a 4-hour shift reserves 240 minutes and leaves 360 | PASS | status 201  |
| SCH-01, AUT-01 | balance shows 240 reserved and 360 remaining | PASS | reserved 240 remaining 360 |
| SCH-07 | a retry with the same key returns the same shift and creates no second one | PASS | status 201 |
| SCH-02 | a 7-hour shift is refused when 6 hours remain, with the exact hours stated | PASS | status 409 Not enough authorized time remains this month for this shift: 6 hr available, this shift needs 7 hr |
| SCH-03 | two simultaneous 4-hour shifts for the last 6 hours: exactly one is accepted | PASS | statuses [201, 409] |
| SCH-03, AUT-01 | after the race the reserved total never exceeds the authorization | PASS | reserved 480 remaining 120 |
| SCH-10 | cancelling releases the reserved time (480 minutes) and the balance returns to its start | PASS | released 480 reserved 0 remaining 600 |
| SCH-10 | a cancelled shift cannot be changed again | PASS | status 409 |
| SCH-04 | the same caregiver cannot be booked for overlapping shifts | PASS | statuses 201/409 This caregiver already has a shift at that time |
| SCH-09 | call-out makes the shift need coverage; a replacement covers it; history keeps both; reserved time unchanged | PASS | statuses 200/200/200 reserved 180 |
| REC-01 | the preview lists every date with its outcome before anything is saved | PASS | status 200 rows 28 |
| REC-02 | in every month the dates marked ok fit the hours still available; nothing is shortened | PASS | months {'2026-11-01': (600, 600), '2026-12-01': (600, 600)} flagged 18 |
| REC-02 | creating the series while dates are flagged is refused and saves nothing | PASS | status 409 Some dates cannot be scheduled: 11/16/2026 (exceeds authorization), 11/17/2026 (exceeds authorization), 11/18/2026 (exceeds authorization), 11/19/202 |
| REC-03, REC-02 | choosing to skip creates exactly the dates marked ok and records the rest as skipped | PASS | status 201 created 10 skipped 18 (preview ok 10 flagged 18) |
| REC-09 | changing one occurrence moves only that date; the others and the count are unchanged | PASS | status 200 count 10/10 |
| REC-10, REC-11 | ending the series from its first date cancels every scheduled occurrence and releases their time | PASS | status 200 result {'cancelled': 10, 'releasedMinutes': 1200, 'kept': 0} left 0 |
| AUT-01, REC-10 | after ending the series the reserved time for 2026-11-01 is back to zero | PASS | reserved 0 remaining 600 |
| AUT-01, REC-10 | after ending the series the reserved time for 2026-12-01 is back to zero | PASS | reserved 0 remaining 600 |
| RPT-01, DSH-01 | the dashboard's hours by service equal the sum of the client balances (authorized, billable, remaining) | PASS | status 200/200 mismatches [] |
| AUT-01 | every balance row: remaining = authorized - billable - reserved (never below zero) | PASS |  |
| DSH-02 | Action needed counts are whole numbers, never negative or missing | PASS | status 200 [0, 0, 0] |
| VIS-01, VIS-02, VIS-04, VIS-05, VIS-06, VIS-08, VIS-11, EVV-01, SMK-05 | standard Service Verification workflow: 38 checks (start, end, confirm, lock, correction, billing review) | PASS | no checks ran |
