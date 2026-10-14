# Proposal 1: one authorization calculation, four plain words (decision D1)

**Status: PROPOSED. Nothing built.** Owner direction: "Use one consistent calculation throughout Ogevia. Distinguish Authorized, Serviced, Scheduled/Reserved, and Available. Prevent the current visit's reservation from being deducted twice."

## What exists today (VERIFIED in the migrations)
| Place | "Used" | "Scheduled / reserved" | "Left" |
|---|---|---|---|
| Caregiver Start screen (`list_authorized_services_for_client`, 0014) | `authorization_month_usage` | **its own sum of scheduled shift lengths** for that client and service (status scheduled, not called out); **not shown** | computed in the browser: authorized minus used (ignores scheduled) |
| Scheduling cap check (`authorization_month_reserved` + usage, 0026/0049/0052) | `authorization_month_usage` | **reservation rows**, minus those counted as used | server-side |
| Office monthly summary (`list_monthly_service_summary`, 0036/0049) | billable minutes | reservation rows, same exclusion | authorized minus billable minus reserved |
So the caregiver screen, the cap check and the office report each compute "scheduled" a different way, and "left" two different ways.

## Proposal
1. **One server function**, `ogevia.authorization_position(lineage, month, for_visit default null)`, returning: `authorized`, `used`, `reserved_other`, `reserved_for_this_visit`, `left`. It reuses `authorization_month_usage` and the reservation rule from 0049/0052 (no new accounting rule). All three places above read it.
2. **Definitions (for the glossary):** *Authorized* = hours in the authorization. *Used* = minutes counted from visits (word replaces "Serviced"). *Reserved* = held for shifts not yet done, excluding any minutes already in Used. *Left* = authorized minus used minus other reserved.
3. **No double deduction of the current visit:** when `for_visit` is a visit linked to a shift, that shift's reservation is reported as `reserved_for_this_visit` and is **not** subtracted in `left` for that visit's screen. Without a linked shift it is zero. The office screens (no visit) keep subtracting every reservation.
4. **Caregiver screen:** one card, four values (Authorized, Used, Reserved, Left), replacing the two duplicate summaries. It lands after PR #87, because the Start screen is a Wave 1 file.

## Change classes
- Database: one new function; the three existing readers are rewritten to call it (create or replace; same return shapes plus additive columns). No table, no stored row.
- API: additive fields on the services list (`reservedMinutes`, `reservedForThisVisitMinutes`, `leftMinutes`); old fields stay.
- Web: the Start/Active screens, then the monthly summary labels.

## Risks and tests
- Changes numbers the office relies on. Mitigation: a **parity test** that, for a spread of fixtures (signed, in review, cancelled, called out, amended), `left` from the new function equals the old office summary and the cap check, and that any intentional difference (the caregiver screen now subtracting reserved time) is listed.
- Cases: current visit's own reservation; visit in review (0052); cancelled shift releases; called-out shift; amendment up and down; month boundary; two services; late confirmation accepted (0049); concurrency of the last minutes.
- Do not combine with F2, F4, F6, F8.

## Decisions needed
Approve the four definitions and the "left" rule in point 3; approve the order (after #88 and #87 merge).
