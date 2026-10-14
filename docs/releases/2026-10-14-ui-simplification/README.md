# UI-only simplification: readiness table, client List/Cards, shorter copy

**Status: IMPLEMENTED and TESTED LOCALLY. NOT DEPLOYED. Web changes only: no database, API or business-logic change.**
Authorized by the owner on 2026-10-14 (D6, D7 and "independent UI-only changes"). Based on `main`, independent of PR #87.

## What changed
1. **Readiness (Care Team):** the long bulleted card is now a table: Issue, Affected, Status, Next action. The exact required words stay ("Service checks: Off", "Report-only. Readiness checks are NOT active."). Setup incomplete, missing documents, availability, service approvals, booked shifts and standing assignments are separate rows. Report only, Active and Would block if activated come from the server's `enforcementActive`, so an inactive check is never described as blocking. Long text sits behind Details.
2. **Clients:** List and Cards views, with search, status filter, authorization filter and sort shared by both. Default is List on a wide screen and Cards on a phone. The choice is saved per signed-in person (see decision below). Same data and same permission (`clients.names.read`); nothing extra is exposed. The earlier "View authorized hours" action is kept.
3. **Copy:** 13 long paragraphs on screens Wave 1 does not touch now have a short line and the rest behind Details (`ShortHelp`). Warnings stay visible ("Review the paper form before any billing", "Nothing becomes billable until a person accepts the confirmation", "Ogevia does not send email or text reminders"). A test fails if a literal paragraph exceeds 220 characters. Proposed glossary: `docs/product/TERMINOLOGY_GLOSSARY.md`.

## Evidence
| Check | Result |
|---|---|
| New readiness tests against the old card (`failing-first.txt`) | 5 of 5 fail |
| New client view tests against the old page | 5 of 6 page tests fail (the access test already passed) |
| `@carelik/web` tests | 93 files, 777 tests pass |
| lint, typecheck, build, all package tests | pass |
| Local harness, Chromium (list default, Cards saved across reload, phone default Cards, no horizontal overflow at 390 px) | observed; screenshots in `screenshots/` |

## Decisions taken / still open
- **Per authenticated user:** implemented as a saved choice keyed by the signed-in person's id **on that device** (browser storage). It is not shared with other people, but it does not follow the person to another device. Following them everywhere needs a stored preference in the database (small additive table and two routes): **not built, needs your approval.**
- Tests changed because wording moved: the assignment-override test (new first sentence) and the Clients test (the row now lives in a table, action text unchanged).

## Not touched (Wave 1 screens, wait for PR #87)
Caregiver Start screen, visit review, schedule and open shifts, visit rules, attestation and outcome copy.
