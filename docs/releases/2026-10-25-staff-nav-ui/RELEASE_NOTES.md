# Staff management, navigation and simpler screens (DEVELOPMENT, not deployed)

Branch `claude/staff-management-nav-ui`, cut from `main` at `466f8ac`. **Implemented and tested locally. Not deployed anywhere. No production, TEST or Demo resource was touched.**
Status words: *implemented* = in this branch; *tested* = said where; *deployed* = nothing yet.

## 1. Environment findings (verified before work)
| Environment | What it is | Evidence |
|---|---|---|
| Development | Local only: `ogevia_local_harness` on a local PostgreSQL, self-signed `https://localhost`, stand-in sign-in. There is no AWS Development stack, pool or database. | VERIFIED in code (`local-harness`, `config.ts` accepts only `prod` and `prd`); the harness and every DB test refuse a database that is not on this computer (`assertSafeTarget`). |
| Test / Demo | One environment: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, pool `us-west-2_849AYz5J7`, API `s0epy5rgzb`; `demo.ogevia.com` is an alias of the same distribution. Not separate (B1 in the environment audit). | VERIFIED in code (`config.ts`, PR #102); live state not read. |
| Production | `Ogevia-prd-*`, `ogevia_prd`, dedicated pool `us-west-2_FHJoX71ca`, API `zk527zk4ua`. Shares the RDS instance, VPC and NetworkEgress stack with Test. | VERIFIED in code; live state not read. |
Consequence: nothing here deploys. Development has no AWS target, and Test/Demo are not isolated from each other, so every deployment step below waits for approval.

## 2. What changed
- **Staff management (migration 0086, API, screens).** `People > Staff`, `Settings > Staff Types`, `Settings > Roles & Permissions`. See section 3.
- **Navigation.** Five sections (Home, Schedule, People, Operations, Settings; a caregiver sees "My work"), collapsible, tabs 32 px in and smaller links 48 px in, plus a horizontal tab strip above each page. Every earlier page and link is kept (Authorization changes, Verify visit, Outage records, Visits to review, Branding, Accounts ...). Appearance settings are untouched.
- **Less explanatory text.** Calculation notes, report definitions and "how this works" paragraphs moved behind the compact Help control (the info icon; the text stays in the page for screen readers). Errors, empty states, validation, real warnings and the public client pages are unchanged. `HelpLine` is now icon-only unless marked `important`.
- **Numbered lists.** A No. column on the Clients and Caregivers lists and on the caregiver-hours, monthly-hours-and-billing and full-chain report tables. Numbering follows the filter and sort. CSV exports are unchanged.

## 3. Staff types and permissions: how it works
- A **staff type** is a label per agency (default list: Administrator, Manager, Scheduler, Coordinator, Supervisor, Office Assistant, Caregiver). Agencies add, rename, deactivate and reactivate their own. There is no column, function or trigger that turns a type into a role or permission; a type named "Organization Owner" grants nothing (tested).
- A **system role** (`organization_memberships.role`) is the only source of authority. Supported to assign: Admin, Manager, Scheduler, Coordinator, Staff, Read only. Never assignable here: Owner (protected), platform owner, caregiver, client-side roles. Only the Owner grants or removes Admin. Nobody changes their own role. A reason is required and audited.
- `staff.read` and `staff.manage` are held **only by the organization owner**. Widening that is an owner decision (one `role_permissions` row).
- **One role per person per agency** (the existing model). Several roles per person are NOT supported; that needs a permission-architecture decision.
- **No duplicate identities.** Caregivers stay in `caregiver_records` (listed in Staff from that record; no copy, no second profile, no second sign-in). Staff profiles are for non-caregiver staff; people who already have access but no profile (for example the owner) are listed and can be given one. Invitations use the same identity function as caregivers; the sign-in email is stored apart from the contact email and phone.
- Disable / enable access reuses the existing accounts functions (0048).
- **Not built:** administrator-initiated password reset (the identity function cannot do it; an unsigned-in person can be sent the invitation again, a signed-in person uses "Forgot password").

## 4. Migration and rollback
**PENDING, not part of any release set.** `infra/aws/db/pending/migrations/0086_staff_management.sql` (two tables, 6 internal and 15 API functions, one trigger, two permissions; `note_my_sign_in` also marks a staff invitation). Rollback `infra/aws/db/pending/rollback/0086_staff_management.down.sql` is **BACKUP REQUIRED** (drops the two tables with their rows; sign-ins, memberships and roles already granted stay; audit history stays). The approved production release is pinned to migrations 0001-0085 and is unchanged. Tests apply it through `db/test/pending.ts`; `db/pending/README.md` lists the promotion steps (move into `migrations/`, re-pin the release package and verification files, snapshot, TEST first). Applying it to Test or Production needs approval and a snapshot first.

**API routes are switched per environment.** The 13 staff routes are created only where `config.features.staffManagement` is true (the Test/Demo slice); the Production API stack (`prd`) is byte-for-byte unchanged by this branch except the Lambda asset hash, because the flag is false there. Enabling it in production is a separate approved change together with the migration.

## 5. Not verified
- Anything on Test, Demo or Production. Real phone, keyboard traversal, screen reader, and printing/PDF of the changed report tables. The Large-text / Compact / Dark appearance matrix on the new layout.
