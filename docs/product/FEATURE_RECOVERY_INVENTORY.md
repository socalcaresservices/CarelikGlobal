# Ogevia feature recovery inventory

Recorded 4 October 2026. Basis: repository inspection of branch `claude/ogevia-socal-pilot-prep-vfu5tf`
(code, migrations, routes). **Not** a live check: no Supabase production or AWS TEST system was queried.
Answers item 1 of the consolidated brief in [OGEVIA_UX_CHANGE_LIST.md](OGEVIA_UX_CHANGE_LIST.md).

## How the two builds differ

One React app, two builds, chosen at build time by `VITE_AUTH_PROVIDER`
(`apps/web/src/main.tsx:12`):

- **Supabase build** (current production on Netlify): the full product. Routes in `App.tsx`,
  `routes/tenant-routes.tsx`, `routes/platform-routes.tsx`.
- **AWS build** (`cognito`, the TEST pilot): only Service Verification, Visit records,
  Billing review, Care requests and Availability (`apps/web/src/aws/aws-root.tsx`). Every
  other module is **not migrated**. It is not lost: the code and the Supabase data still exist.

Classification:
- **Working (AWS)** means code plus an AWS route plus automated tests, run locally on synthetic data.
- **Not migrated** means the code works in the Supabase build but has no AWS API, database objects or route.
- **Absent** means no code anywhere.

## Module status

| Module | Supabase build | AWS build | Recovery action |
|---|---|---|---|
| Service Verification (4 stages) | Working | Working | Keep. The phone test needs repeating after the pilot deploy. |
| Visit records / Report Center | Working | Working, with gaps: no client names (code only), no locations, letterhead has no logo | UX change list items (visit list, filters, calendar) |
| Exceptions / NEEDS ATTENTION | Report view plus Action Center | Report view only | UX item 2: make it a visible entry with a count |
| Billing review | Working | Working (read-only, hours only) | Done |
| **Billing approval (human)** | Working (`approve_visit_for_billing`) | **Built on this branch (0019), not deployed** | Deploy needs approval |
| Payer submission | Supabase has a manual "mark as submitted" ledger (owner, `billing.submit`); it sends nothing to payers | Not migrated | **Automatic payer submission and eBilling connectors are out of launch scope** (owner decision, 2026-10-04). A manual "recorded as submitted" ledger is a later, optional item; it is not a launch requirement. |
| Owner utilisation / financial home | Hours stand-in (`owner-insights.tsx`), not revenue | Absent | New build per brief; needs rate and cost sources |
| Payroll / caregiver cost / margin | Absent | Absent | Needs a cost data source; do not fabricate |
| Clients, Care Team, Authorizations, Schedule | Working | Not migrated (DB has `amend_client_authorization` but no route) | Migrate in order: authorizations, schedule, clients, team |
| Care Requests / Availability | No equivalent (claim-shift link only) | Working | Keep |
| Matching / CareScore | Working (`_score_caregiver_matches`, 0–100 (note: the July archive used a different weighting, so the later Supabase definition is the current one): proximity 30, language 25, availability 12+8, skills 10, history 15) | Availability filter only, no score | Port the existing formula unchanged; show its explanation |
| AskCare | **Not in this repository.** The July archive (`socalcaresservices/carelik`, `app.html` lines 1673–1690 and 6523–6680, build tag `v2026.07.04-askcare`) has a working **rule-based operational question box**: four intents matched by regular expression against browser-loaded data ("best staff for X" using an archive CareScore of availability 30, skills 30, language 20, capacity 20; "who's free <day>"; "who's unstaffed"; "how much am I losing in <city>" = unstaffed authorised hours × service bill rate). **No external AI**: no model, provider or network call. | Absent | Recover as an operational question interface over server-side, permission-checked queries. It is not an AI assistant. Its "losing" figure counts unused authorisation as loss; the brief says to label it potential revenue instead. |
| Branding (logo, colours) | Working: stored in the database (`organizations` columns) plus a public Supabase bucket | Absent (logo hard-coded to none) | Migrate the columns; use private S3 with signed reads |
| Documents / credentials / reminders | Working | Not migrated | Minimal module per brief |
| Candidates / applicants | Working | Not migrated | Preserve; not on the launch path |
| Settings, Access, Incidents | Working | Not migrated | Migrate as needed by the modules above |
| Public landing, pricing | Working (marketing hosts) | Absent (AWS `/` requires sign-in) | Hosting decision; the Netlify landing still exists |
| Platform admin | Working | Absent | Not needed for the pilot |
| Tasks | Absent | Absent | No new module (brief) |

## Header and identity (UX item 4)

- No build shows the signed-in person's name or a role label.
  - Supabase shows a greeting with the role, plus the email.
  - AWS shows the email only.
- `get_my_context()` returns no display name, although `app_users.display_name` exists.
- Fix: return the display name from `/v1/me`. Show OWNER / MANAGER / CAREGIVER VIEW, derived from role and permissions. When no name is set, show an explicit "Name not set" fallback.

## Known defects found during inventory

| # | Defect | Build | Status |
|---|---|---|---|
| 1 | Supabase nav declares a `permission` per item but `visibleItems()` ignores it. Pages and RLS still enforce permissions, so this is a navigation-only issue. | Supabase | Open |
| 2 | Billing review table `<th>` cells were not exposed as column headers to assistive tech. | AWS | Fixed (`scope="col"`) |
| 3 | The billing review table scrolls sideways inside its card at 390 px. Visit and date are off-screen (the page itself does not scroll). | AWS | Open; covered by the visit-list card layout item |
| 4 | Confirmation method shows the raw value `unable_to_confirm`. | AWS | Open (plain-language labels item) |
| 5 | Production: correcting a visit that is already approved for billing leaves the approval active on the replaced row. The replacement is listed as Billing Ready again, can be approved again, and both approvals can be submitted (reproduced: 210 min submitted for one 90-min visit). The live production function bodies are byte-identical (md5) to the reproduced code. Production currently has **0 approvals and 0 corrections**, so nothing has been double-billed. | Supabase | Reproduced in `supabase/tests/billing-correction/`. Proposed fix written and verified there; **not applied** (needs a production approval). Prevented in AWS 0019. |
| 6 | A database test failed when run in the last ~12 s of a minute (Time Out moved into the future). | test only | Fixed |
