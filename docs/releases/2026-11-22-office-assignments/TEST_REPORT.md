# TEST report: offices, service counties, Caregiver Color (0111)

Site: https://d2xumch5w0izfg.cloudfront.net (TEST only, dummy records). Release commit f91ea1c1db7306bc8559449ce8d198e2971fc386.

## Deployment evidence (operator output, 2026-11-22)
`H7 COMPLETE (TEST)`: verified backup; migration 0111 in one transaction (ledger 110/0111, all 58 object checks); API 268 -> 276 routes (the 8 new routes answer 401 without a sign-in); web bundle carries the release commit. Rollback reference: the H7 capture directory printed by the script. Production: not touched.

## Owner checks (Administrator unless stated). Nothing here is confirmed until the owner says so.
| # | Where | Do | Expect |
|---|---|---|---|
| 1 | Settings > Offices | Add "Temecula Office" (address, city, ZIP, county Riverside) and "Moreno Valley Office" (county Riverside) | Both listed with address and "Riverside County"; two separate offices |
| 2 | Settings > Offices | Edit Temecula: change the address/city | New address shown; its client and caregiver counts unchanged |
| 3 | Clients > open a dummy client > Details | Assign Temecula, add Moreno Valley, Make primary, set Service County | Primary first; refresh keeps everything |
| 4 | Staff > Caregivers > open a dummy caregiver | Assign Temecula (primary) + Moreno Valley (additional); add two Service Counties; pick Red, Yellow, Blue on three different caregivers | Saves; swatch beside the name in the heading; yellow is outlined |
| 5 | Staff > Caregivers (list) | Office = Temecula, then Moreno Valley, then All Offices, then Unassigned; County filter; combine with Status and Search | The two-office caregiver appears under both and once under All Offices; filters combine |
| 6 | Clients (list) | Office and County filters | Matches any assigned office; clients with none show under Unassigned |
| 7 | Settings > Offices | Retire Moreno Valley (reason), then open the caregiver | Office still shown "(retired)"; not offered for new assignments; Reactivate restores it |
| 8 | Scheduling > Schedule | Look at shifts with a coloured caregiver | Small swatch beside the caregiver name; status colours unchanged |
| 9 | Operations > Reports > Overview, "Group by Caregiver" chart | Check a coloured caregiver | The slice/bar uses the saved colour |
| 10 | Sign in as Manager and as a caregiver | Open the same pages | Manager can assign per their permissions; a caregiver sees no office controls |

## Records needing manual assignment
Every caregiver, and every client with no earlier office, shows Unassigned until an administrator assigns one. Counties and colours start empty.
