# Offices (minimal): migration 0110 and the Office filters

**Owner request (2026-11-21):** the Billing review should filter by review reason **and** by office ("both"). There was no office in the data, so the owner approved building a **minimal Offices feature** first ("Yes, minimal offices").

**Status: IMPLEMENTED AND TESTED LOCALLY. NOT DEPLOYED ANYWHERE. Release switch OFF everywhere** (`features.offices` is absent in every environment, so no route exists and no synthesized template changes).

## What it is
| Layer | Change |
|---|---|
| Database (pending `0110_offices.sql`, additive) | Table `offices` (agency, name 2 to 80 characters, unique per agency ignoring case, active flag, who and when). Nullable `clients.responsible_office_id` with a composite foreign key (a client can only point at an office of its own agency). Six functions: `create_office`, `rename_office`, `retire_office`, `list_offices`, `list_client_offices`, `set_client_office`. Rollback: `pending/rollback/0110_offices.down.sql`. |
| API (six routes, all behind the switch) | `GET /v1/offices`, `GET /v1/client-offices`, `POST /v1/offices`, `POST /v1/offices/{officeId}/rename`, `POST /v1/offices/{officeId}/retire`, `POST /v1/clients/{clientId}/office`. |
| Web | Settings > Offices (Administrator); a "Responsible office" control on the client page (clients.manage); an **Office** filter on Billing review, on the Reports record lists and on the Clients list. Every office control stays hidden unless the office list actually loaded (so nothing shows, and nothing breaks, where the switch is off). |

## Rules
- Only the agency Administrator (`organization.update`) creates, renames or retires offices; a manager with `clients.manage` assigns a client; reading needs `clients.names.read` or `billing.read` (a caregiver sees none).
- A retired office keeps its history and its clients, appears as "(retired)", and cannot be chosen for new assignments.
- **Responsible office is one thing only.** It is not the service location, the payer or the authorization, and it does not change who can see what. No office-based permissions yet.
- Existing clients have no office until someone assigns one. Nothing existing changes: no current function, report or hour calculation is touched. The Office filter in Billing review maps the visit's client code to an office; it never changes a record.

## Tests (local)
Database `offices-0110.db.test.ts` (9: rules, idempotency, permissions, tenant isolation, history, rollback and re-apply); API `offices.db.test.ts` (3) and the tenant-isolation sweep (a real office row is created so the six routes are probed); CDK `offices-switch.test.ts` (3: absent everywhere; exactly six JWT routes when on); web `offices.test.tsx` (8). Full suites: web 1382 passed.

## Not done / next
- No release tooling yet for 0110 (TEST ledger tool, production SQL helper, route change set): to be built on the owner's GO for a TEST release, like 0109.
- Not covered by a page-level automated test: the Office select on the Reports page (the filter rule itself is tested once and shared by all three screens).
- Out of scope, still open from the 2026-11-18 checklist: office-based permissions, caregivers shared across offices, per-office finance totals, payer and service-location fields.
