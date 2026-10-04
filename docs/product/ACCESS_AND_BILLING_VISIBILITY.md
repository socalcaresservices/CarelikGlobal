# Ogevia AWS TEST: who can see and do what

Owner decision (3 October 2026): managers may approve billing; payroll, costs, margins and agency finances stay owner-only.

Implemented in AWS migrations 0019–0021 on branch `claude/ogevia-socal-pilot-prep-vfu5tf`. Not yet deployed.

## How it is enforced

Every rule here is enforced in PostgreSQL functions, which are the only thing the application role may call. The application role cannot read or write any table directly. Hiding a button is never the control.

Tests:
- `access-roles.db.test.ts`
- `workspace.db.test.ts`
- `documents.db.test.ts`
- `apps/sv-api/test/workflow.db.test.ts`

## Manager billing visibility

| Data | Manager | Owner |
| --- | --- | --- |
| Billing Ready / Needs review visits: date, service, client code, worked, verified and billable minutes, authorization status, confirmation method, signature | Yes | Yes |
| Approve the billable minutes of a Billing Ready visit (0 to billable), with an optional note | Yes | Yes |
| Void an approval (reason required; the visit returns to Billing Ready) | Yes | Yes |
| Approval list: who approved, when, minutes, notes, void history | Yes | Yes |
| Rate per hour, approved dollar amount | **No** (the server returns null) | Yes |
| Home: authorized, scheduled, worked, billable, approved hours and hours left by service | Yes | Yes |
| Home: billable value, approved value, potential value of unused hours | **No** (null) | Yes |
| Caregiver pay, labour cost, margin, profit | No | Not available: no pay data source exists, so the UI shows "Unavailable" |
| Payer submission, invoices, exports | Out of launch scope: Ogevia does not submit to payers (approval is not submission) | Out of launch scope |
| Change agency branding | No | Yes |

The approval audit rows store minutes only, never dollar values.

## Other roles

| Role | Billing | Visits | Documents |
| --- | --- | --- | --- |
| Scheduler | None | Visit records (read); NEEDS ATTENTION counts without the billing count | None (Scheduler access still needs your definition) |
| Caregiver | None | Own visits only | Own requested documents: view and upload |
| Another agency | Nothing from this agency | Nothing | Nothing |

## Controls on approvals and documents

- **One approval per visit.**
  - A visit can have only one active billing approval.
  - A retried approval returns the same approval.
  - Of two simultaneous approvals, exactly one succeeds.
  - An approved visit cannot be corrected until its approval is voided.
- **Documents.**
  - Nobody can review a document they uploaded themselves.
  - Rejecting needs a reason.
  - Versions are kept forever, and every file view is audited.
