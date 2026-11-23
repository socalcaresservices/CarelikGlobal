# Shift drawer (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

The earlier requirements were not available. "Add shift" already opened in a drawer (R5); "Shift drawer" is read as the same treatment for an existing shift's change forms, which opened inline under the row and pushed the list down (R12: rarely used detail in a drawer). This reading needs owner confirmation.

## What changed (`apps/web/src/aws/schedule-page.tsx`)
- Assign / change caregiver, record call-out, cancel, change time, schedule make-up and history now open in the existing side drawer (`ui/drawer.tsx`; full screen at 390 px). The row and the list stay where they are.
- The drawer is titled with the action and the shift, and starts with a summary: client, when, service, caregiver, status.
- Closes with Escape, the close button, a tap on the dimmed page, or the form's own Close; focus returns to the control that opened it (existing drawer behavior).
- A link from Action needed that auto-opens "Assign" (`autoAssign`) now opens the drawer rather than an inline form.
- No change to who may act, to what each form does, or to any API call.

## Tests
- New: `schedule.test.tsx` "opens a shift's change forms in a side drawer..." (dialog name, summary, not under the row, Escape, Close).
- Updated to look in the dialog instead of the row: the call-out, assign, history and make-up tests (`schedule.test.tsx`, `scheduling-patterns.test.tsx`).
- Full web suite passes (1347).
