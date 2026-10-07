# Migration Plan (Phase 0 draft)

**Status:** DRAFT — depends on live AWS inventory (BLOCKED, see CURRENT_AWS_INVENTORY.md). No AWS or Supabase mutation has been made.

## Findings that change the plan
1. `infra/aws` has generated output only; **no CDK source**. Phase 1 must author the CDK app; the existing `cdk.out` is a reference, not a source of truth.
2. Committed WebHosting stack (CloudFront + Cognito client) conflicts with CLAUDE.md §3 (Netlify stays). Exclude until approved.
3. Committed API stack has 122 routes; the approved Phase 4 scope is ~8 operations. Build the minimal set first.
4. Browser calls Supabase RPCs and Storage directly; all must move behind the API (tenant checks currently rely on RLS + `auth.uid()`; the Lambda must replicate them server-side, not trust claims blindly).
5. `docs/deployment/FINAL-DEPLOYMENT-SUMMARY.md` presents a single-push, 80-minute, "no clarifying questions" execution. That contradicts CLAUDE.md §13 yellow gates and §14 phase exit gates. CLAUDE.md wins; do not execute that plan.

## Source → target map (Service Verification slice)
| Supabase | AWS target |
|---|---|
| `auth.users`, `auth.uid()` | Cognito user + groups; JWT `sub` mapped to `users` row; org derived server-side |
| RLS policies | Lambda authorization layer + parameterized queries scoped by `organization_id`; keep RLS on RDS as defense in depth (session variable set per request) |
| RPCs in §3 of inventory | Lambda handlers calling equivalent PL/pgSQL functions (port, don't redesign) |
| `visit-signatures` bucket | Private SSE-KMS S3 bucket; random-key object names (no client/visit PHI); DB stores key + metadata |
| Supabase functions (invite/revoke member, etc.) | Out of Phase 1–6 scope (DEFER) |

## Order and gates (per CLAUDE.md §14)
0. Reconcile reality (this) → **gate: owner reviews inventory + credentials restored**
1. Author `infra/aws` CDK app (synth/test only) → gate before bootstrap/import/deploy
2. Port schema subset + functions as idempotent SQL; test against a local/throwaway PostgreSQL, no real PHI
3–6. Cognito, API, S3, UI adapter behind a feature flag (Supabase path stays default)
7–8. Security/cost gate, then cutover with rollback

## Risks
- 162 migrations include non-SV features; extract only the SV dependency closure (clients, caregivers, assignments, services, authorizations, shifts, visits, confirmations, corrections, audit). Closure not yet computed.
- Billing/authorization functions (`approve_visit_for_billing`, authorization usage formulas) are coupled to SV; scope decision needed before Phase 2.
