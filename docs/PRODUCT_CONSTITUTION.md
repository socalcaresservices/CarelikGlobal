# CareLik Global — Product Constitution

This is the standing rulebook for how work gets done in this repository,
independent of any one chat session or prompt. A prompt is transient -
it disappears when the conversation ends. This document is checked into
the repository, so every future build (by an AI assistant or a human
engineer) starts from the same rules, not from re-explaining them from
scratch. `docs/design-system.md` is this document's companion for
visual/component rules specifically; this document covers everything
else - what CareLik is, how a build gets scoped, and what "done" means.

## What CareLik is

CareLik is a Workforce Operations Intelligence platform. It is not a
scheduling app, not an EVV (electronic visit verification) system, and
not a generic HR platform - those are all things it touches, but none
of them is what it's *for*. It exists to answer three questions on
every screen, fast: what's happening, what needs attention, and what
should happen next. A feature that doesn't serve one of those questions
is decoration, not product.

## Audit before every build

Before writing code, read the code. Inspect the relevant routes, pages,
reusable components (`packages/ui`), database schema and RPCs
(`supabase/migrations`), and business logic (`packages/shared`) for the
area about to change. This isn't a formality - it has changed real
decisions in this project:

- A request to make caregiver "skills" configurable looked like a
  small lookup-table swap until an audit of `list_caregiver_matches()`
  found that CareScore already matches caregiver skills against client
  care needs via direct free-text overlap - converting one side without
  the other would have silently broken matching. The audit turned a
  one-line task into a two-sided design problem worth scoping properly,
  before any migration was written.
- A request to "add a dashboard for the owner" turned out to already
  be built (`owner-dashboard-page.tsx`, "Workforce Insights") - the
  real gap, found only by reading it, was that it rolled up every major
  entity except applicants.

Never assume a feature is missing. Grep for it, read the page, check
the migrations. If it exists, the job is to improve it, not to write it
again.

## Don't invent, don't rewrite

If an existing implementation already solves the problem, improve it -
don't replace it, and don't rewrite a working module just because it
would have been built differently from scratch. Reuse is the default;
replacement needs a real reason (a security gap, a genuine
architectural dead end), not a stylistic preference.

This isn't absolute, though - reuse is preferred, not mandatory when
it's actually wrong. `get_caregiver_notes` was written as its own new
RPC instead of being folded into the existing `get_caregiver_location`
(which already returns a caregiver's own profile to themselves) because
that reuse would have silently given every caregiver read access to
staff-authored notes about them. Correctness beats reuse when they
conflict; reuse still wins every other time.

## No fabricated numbers

Already law, and it stays law: never show a metric without a real data
model computing it (see `docs/design-system.md`'s "Not yet built"
section for the discipline this has produced - features that wait for
a real data model instead of shipping a guess). The one recorded
exception is `ScoreBadge` (CareScore/GeoScore preview, Build 001.5),
built with sample data at explicit user direction, and deliberately
designed so that exception can never leak silently: `preview` is a
required literal `true` prop, not a default, and the badge always
renders a visible "Preview" tag. Any future exception to this rule
needs the same treatment - explicit, visible, and impossible to use by
accident.

## One shared design system

Every screen reuses the tokens and components `docs/design-system.md`
and `packages/ui` already define - typography scale, semantic colors,
the 8-point spacing convention, `Card`/`Button`/`StatusChip`/
`MetricStrip`/the states components. No screen invents its own button
style, its own status-pill colors, or its own spacing scale. When a
new UI pattern is genuinely needed, it's added to `packages/ui` with a
comment explaining what duplicated markup it replaces (every existing
component there already follows this), not hand-rolled inline on one
page.

## Data ownership

Every business entity has one source of truth. A caregiver's skills, an
agency's service catalog, a client's authorized hours - each lives in
exactly one table, referenced everywhere else, never re-typed into a
second place. Nothing that can be computed at read time gets stored:
credential status, authorization usage/expiry status, and CareScore are
all derived on the fly from raw dates and hours, precisely so they
can't drift stale the way a stored, periodically-recalculated field
eventually does.

## Build discipline

One coherent objective per build. State plainly what's in scope and
what's deliberately deferred and why (every build in this project's
history does this in its migration comments and commit messages -
that's not incidental, it's the standard). Don't touch modules unrelated
to the build's stated objective in the same pass - a build that quietly
grows to touch ten unrelated files is a build nobody can review or
revert cleanly.

## Documentation is part of the build

An architecture change isn't finished when the code merges - it's
finished when `docs/design-system.md`'s "Current implementation status"
section (or this document, when the change is process-level rather than
UI-level) reflects it, and migration files carry comments explaining
*why*, not just *what*. A future build's audit step only works if the
docs it reads are accurate.

## Build for a machine reader too

Business rules live in the database - RLS policies, `SECURITY DEFINER`
functions with an explicit `has_permission()` check, `check` constraints
- not hidden inside a component's `onClick` handler. This is already
how every RPC in this schema works, stated here so it stays that way:
a rule enforced only in the UI is a rule any other caller (a future
integration, a script, another AI agent working against this same
database) can bypass. Enforce it once, in the data layer, and every
caller inherits it for free.

## Think like the owner

Before a feature ships, ask: will this save an owner time? Will it
reduce a scheduler's workload? Will it improve caregiver retention?
Will it reduce revenue leakage or compliance risk? If the honest answer
is no to all four, reconsider whether it's the right thing to build
next, regardless of how technically interesting it is.
