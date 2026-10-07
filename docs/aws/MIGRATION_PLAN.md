# Migration Plan: Supabase to AWS (Service Verification slice) - Phase 0 draft

**Status:** DRAFT. Based on repo inspection only; AWS live state unverified.

## Repository evidence (VERIFIED by grep, 2026-10-07)
- pnpm monorepo: `apps/web` (React/Vite), `apps/netlify-functions`, `packages/{auth,shared,ui}`, `supabase/` (162 migrations).
- 91 source files reference `@supabase/supabase-js` / `supabase.rpc|from|auth|storage`.
- Service-Verification-relevant RPCs called from the UI: `list_service_visits`, `list_caregiver_assignments`,
  `correct_service_visit`, `list_visit_corrections`, `close_missed_service_visit`, `approve_visit_for_billing`,
  `list_billing_ready_visits`, `reassign_shift`. Start/end/sign RPCs are defined in migrations
  (`20260809042943_service_verification`, `20260824010000_service_verification_v3`, `20260828_visit_verification_redesign`, etc.).
- Signatures: Supabase Storage bucket `visit-signatures` (one call site found). Other buckets (e.g. `organization-branding`) are out of slice.
- Most other RPCs (candidates, plans, billing admin, support access) are outside the slice and stay on Supabase until later phases.

## Mapping (source -> target)
| Component | Source | Target | Class |
|---|---|---|---|
| Auth | Supabase Auth | Cognito (groups: admin, manager, caregiver, rep) | MIGRATE |
| Visit RPCs | Postgres functions via browser | Lambda + same SQL logic on RDS | MIGRATE (translate, do not redesign) |
| Schema | `supabase/migrations/*visit*` | idempotent migrations on RDS | MIGRATE |
| Signatures | Storage `visit-signatures` | private SSE-KMS S3, key = opaque UUID, metadata in DB | MIGRATE |
| RLS | Supabase policies | Lambda-enforced tenant checks + DB constraints; keep RLS where roles allow | MIGRATE |
| Frontend | Netlify | Netlify (unchanged) | KEEP |
| Non-slice RPCs | Supabase | Supabase | DEFER |

## Open technical risks
- RLS policies and `auth.uid()`-based functions depend on Supabase JWT claims; each must be rewritten to take an explicit actor from Cognito claims.
- Supabase-only extensions/roles (`auth` schema, `storage` schema) must be identified per migration before replay on plain RDS.
- 91 files import Supabase; adapter must be introduced behind a flag for the slice only.

## Order (gated, nothing executed)
Phase 0 inventory (blocked on credentials) -> restore CDK source and reconcile with approved scope -> schema extraction and parity tests ->
Cognito -> Lambda API (8 operations) -> S3 -> UI adapter -> security/cost gate -> cutover with rollback. Each yellow action needs owner approval.

## Rollback
Supabase and Netlify untouched until acceptance; feature flag selects backend; no production PHI migrated during development.
