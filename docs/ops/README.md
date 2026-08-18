# Ops scripts

One-time, environment-specific production data fixes live here, not in
`supabase/migrations/`.

`supabase/migrations/*.sql` is a schema history that gets replayed in full
against every fresh environment (local dev, CI, a new staging project,
disaster recovery). A script that only makes sense against the one
production database it was written for — because it hardcodes a specific
customer's email address, org name, or row id — does not belong there: it
either no-ops silently on a fresh database (masking that the fix never
happened) or, worse, matches the wrong rows if a fresh environment happens
to contain different data with the same shape.

## Rules for anything filed here

- Never commit a real customer identifier (email, name, phone, address) in
  plain text. Reference the record by its stable internal id (organization
  id, user id) and keep the human-readable mapping in the team's private
  runbook/ticket, not in git.
- State clearly, at the top of the file, which production project the
  script was run against and the date it was run. These are historical
  records of a completed action, not something to run again.
- If the same kind of fix is needed a second time, write a new dated file
  rather than editing an old one — this directory is an append-only log,
  same as migrations, it's just not auto-replayed.

## 2026-08-17 — tenant ownership separation

Redacted from `supabase/migrations/20260817055211_separate_existing_tenant_owners.sql`
during the readiness-audit remediation (see Stage 0, item 2). The original
migration hardcoded two real customer email addresses and two org display
names directly in a schema-history file. It had already been applied to
the live database (project `cdxxpdyobsqvqveabsda`) before this redaction,
so the migration file itself was left in place as a no-op placeholder
rather than deleted, to avoid creating a gap in migration version history
that other tooling (`supabase migration list`, `supabase db push`)
compares against.

What it did, described without the literal PII: reconciled membership
`status` for three specific accounts across two specific organizations
following an ownership realignment — one owner membership was confirmed
`active`, and two stale memberships (a departing member of one org, and a
platform-owner's leftover membership in another) were set to `revoked`.
The literal email addresses and org names used are recorded in the
team's private ops runbook, not in this repository.
