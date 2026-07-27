begin;

-- 20260727080000_organization_onboarding.sql extended create_organization()
-- with 23 new params using `create or replace function`. Because the new
-- signature has a different parameter *count* than the original, Postgres
-- created a second, separate overload instead of replacing the first one
-- (create or replace only replaces a function with the exact same
-- argument list) - so both the original 5-param create_organization() and
-- the new 28-param one have coexisted in pg_proc since that migration.
--
-- That is what broke organization creation in production: PostgREST
-- returns HTTP 300 "Multiple Choices" (PGRST203, ambiguous function call)
-- whenever more than one function shares a name and it cannot prove a
-- single best match from the request body alone, even when the request's
-- parameter names don't actually satisfy the other overload. This is a
-- known PostgREST limitation with overloaded RPC functions, not a
-- Postgres-level ambiguity - Postgres itself would have resolved the call
-- correctly, PostgREST's own candidate-selection layer is what failed.
--
-- The only caller anywhere in the codebase is
-- apps/web/src/pages/add-organization-page.tsx, and it always calls the
-- full 28-param version. Nothing depends on the original 5-param
-- signature anymore, so the fix is to drop it rather than keep two
-- versions of the same function around.
drop function if exists public.create_organization(text, text, text, text, text);

commit;
