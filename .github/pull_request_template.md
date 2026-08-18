## What changed

## Why

## Validation
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Schema changes
Does this PR add or modify a `SECURITY DEFINER` function, an RLS policy,
or a `GRANT`/`REVOKE` in `supabase/migrations/`?

- [ ] No — skip this section.
- [ ] Yes — I completed [docs/security-review-checklist.md](../docs/security-review-checklist.md)
      and every box is checked, or I've explained below why a box doesn't apply.

## Production migration
- [ ] This PR includes a new file in `supabase/migrations/` that still
      needs to be applied to production after merge, and I've said so
      explicitly here (which file, and any manual step required).
- [ ] N/A — no migration, or already applied and documented.
