# Mobile view improvements (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

"Mobile view improvements" is not itemized in the repository. The documented, open mobile gap is in PR #113's README ("Not done: on phones, Documents and Staff show cards without headings, so their sorting is desktop-only") and tracker row R38. This item closes that gap. Other mobile work already in the build (R13 390 px, R20 bottom bar, the shift drawer going full screen, the 44 px touch targets) is untouched. No real-phone check was possible in this environment; the tests prove behavior, not appearance on a device.

## What changed
- New shared `MobileSortControl` (`apps/web/src/aws/ui/sort-th.tsx`): a "Sort by" select plus a direction button, both at least 44 px tall, hidden from the md breakpoint up where the column headings sort. It drives the same `useSortedRows` state, so a phone sorts by the same columns, with the same rules (text A-Z, dates newest first, numbers smallest first, empty values last), as a desktop.
- Used on Staff (`staff-pages.tsx`: name, staff type, role, sign-in status, staff record, contact email, phone) and Documents (`documents-page.tsx`: document, caregiver for managers, last upload, status).
- Phone cards elsewhere already carry the shared sort or are not sortable lists; nothing else changed.

## Tests
`ui/mobile-sort.test.tsx` (4), `staff-pages.test.tsx` (1 added), `documents-cancel-retire.test.tsx` (1 added). Full web suite passes (1362).

## Not verified
Real phone widths and touch behavior (R13 evidence still needs a device or the owner's check).
