# Phase 3: User Migration Mapping

**Nothing was migrated.** The rows below are SYNTHETIC examples. The real dry run is executed by the owner later:

```bash
pnpm --filter @carelik/infra-aws user-migration:plan <sanitized-export.json>
```

The tool (`infra/aws/lib/user-migration.ts`, 7 tests):
- reads a local JSON export containing ids, emails and flags only;
- **refuses** any field named like a password, hash, token, secret or credential;
- makes no AWS or database call and writes nothing;
- prints SHA-256 email prefixes instead of addresses.

## 1. Password strategy: Option A vs Option B

| Criterion | A: User-migration Lambda trigger (lazy migration at first sign-in) | B: Admin-created users + Cognito invitation (RECOMMENDED) |
| --- | --- | --- |
| Password handling by Ogevia code | **Yes**: the trigger receives the plaintext password and must validate it against Supabase | **None**: Cognito generates and delivers a temporary password |
| New infrastructure | Lambda trigger + Supabase credentials in AWS + egress to Supabase | None |
| Works with MFA ON / TOTP | Yes, but the TOTP enrolment still happens at first sign-in | Yes; enrolment at first sign-in |
| User effort | None until MFA enrolment | One invitation email, set a new password, enrol TOTP |
| Supabase password-hash compatibility | Must call Supabase Auth per sign-in (no hash export into Cognito) | Not needed |
| Fit for ~22 users, invitation-only | Over-engineered | Proportionate |
| Risk | Plaintext-password path, a cross-cloud dependency, and logging-leak risk | Users must act on an email |
| Rollback | Remove the trigger | `AdminDisableUser` (never delete) + unlink `cognito_sub` |

**Recommendation: B.** It never touches a password, adds no infrastructure, and matches `AllowAdminCreateUserOnly`. The cost is one email per user. Never log the migration event; never log, persist, or send passwords anywhere (directive).

## 2. Mapping (synthetic examples)

| SOURCE USER IDENTIFIER | COGNITO IDENTIFIER | APPLICATION USER IDENTIFIER | EMAIL MATCH RULE | DUPLICATE EMAIL HANDLING | DISABLED USER HANDLING | UNVERIFIED EMAIL HANDLING | ROLE SOURCE | ORG MEMBERSHIP SOURCE | MIGRATION STATUS | ROLLBACK BEHAVIOR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `00000000-…-000000000001` (Supabase `auth.users.id`) | new `sub` from AdminCreateUser | `ogevia.app_users.id` created by the data migration | `lower(trim(email))` exact; no fuzzy match | n/a | n/a | n/a | `organization_memberships.role` (PostgreSQL) | `organization_memberships` (status `active`) | CREATE_COGNITO_USER_AND_LINK | AdminDisableUser; `cognito_sub := NULL` |
| `…002` | existing `sub` already linked | existing | exact | n/a | n/a | n/a | PostgreSQL | PostgreSQL | ALREADY_LINKED | none |
| `…003` | existing Cognito user, same normalized email | existing, unlinked | exact (case-insensitive) | n/a | n/a | Cognito email must be verified | PostgreSQL | PostgreSQL | LINK_EXISTING_COGNITO_USER | `cognito_sub := NULL` |
| `…004`, `…005` | none | none | exact | **Both blocked**: the owner decides which person owns the address | n/a | n/a | PostgreSQL | PostgreSQL | BLOCKED_DUPLICATE_EMAIL | none (nothing changed) |
| `…006` | none | stays `disabled` | exact | n/a | **Not migrated**; no Cognito user created | n/a | n/a | n/a | SKIP_DISABLED | none |
| `…007` | none | none | exact | n/a | n/a | **Held**: confirm the address with the person before inviting | PostgreSQL | PostgreSQL | HOLD_UNVERIFIED_EMAIL | none |
| `…008` | none | none | exact | n/a | n/a | n/a | n/a | no active membership | SKIP_NO_ACTIVE_MEMBERSHIP | none |
| `…009` | linked `sub` whose email differs | existing | exact | n/a | n/a | n/a | PostgreSQL | PostgreSQL | BLOCKED_CONFLICTING_LINK | none (investigate) |

Rules enforced by the tests:
- Roles are never read from Cognito groups.
- A Cognito user is never deleted.
- The output never contains an email address.
- Same input gives same output.
- Multi-organization users keep one `sub` and one `app_users` row, with one membership per organization.

## 3. Execution outline (Phase 8, after approval)

1. Export a sanitized source list (ids, emails, flags). Run the dry run. The owner resolves BLOCKED and HOLD rows.
2. For CREATE rows: `aws cognito-idp admin-create-user --desired-delivery-mediums EMAIL` (no password parameter) → record `sub`.
3. Run one audited SQL transaction setting `app_users.cognito_sub` per row; then run `db:verify`.
4. Re-run the dry run: every migrated row must show ALREADY_LINKED.
