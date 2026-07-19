# CareLik Global Design System

This is a non-negotiable design principle for every screen built in this
app from this point forward, not a style suggestion. When a new screen
is added or an existing one is reworked, it needs to hold up against
every section below before it ships.

## Philosophy

CareLik is not a scheduling app. CareLik is an operational intelligence
platform.

Every screen must answer, within 3 seconds:

- What do I need to know?
- What requires action?
- What should I do next?

The visual language is Apple-level simplicity. The information density
is Epic-level completeness. Never Salesforce. Never a Windows control
panel. Never an ERP.

## Apple simplicity

Every screen should have: a white background, one accent color, plenty
of whitespace, large typography, few borders, soft shadows, rounded
corners, minimal icons, no visual clutter.

## Epic information hierarchy

The eye naturally scans top to bottom: summary, then status, then
details, then history, then documents. Every record and every dashboard
should follow that order - nothing important should require scrolling
to discover.

### Record layout pattern

A record's header carries the identity plus every headline metric at a
glance - name, status, and whatever 4-6 numbers matter most for that
entity (for a caregiver: something like CareScore, GeoScore, capacity,
availability, compliance). A second row of quick KPIs follows
(desired/scheduled/remaining/gap-style numbers). A third row of tabs
(Overview, Schedule, Capacity, Compliance, Documents, Performance,
Notes, History, Audit) holds everything else. Nothing critical should
be hidden behind a click - if a number matters, it's on the page, not
three levels of navigation deep.

### Lists

Every list is sortable, filterable, and resizable, and shows the
numbers a user would otherwise have to click into each row to find
(capacity, gaps, risk, expirations, distance - whatever is relevant to
that list). No clicking required to see the state of things.

## Dashboard philosophy

Never lead with charts. Lead with operational answers: open shifts,
coverage percentage, available hours, remaining capacity, call-outs,
expiring credentials, expiring authorizations - the numbers an owner
needs to see the instant the page loads, not numbers they'd have to
calculate mentally from a chart.

## The Action Center

Every page - especially the dashboard - starts with "what needs my
attention," before anything else. For an owner that might be: open
shifts, credential expirations, authorization expirations, an incident
awaiting review, a caregiver requesting more hours, a client under
their authorized utilization, a caregiver over their monthly hour
target. This is the single biggest UX improvement over typical home
care software, which makes users hunt for problems instead of
surfacing them immediately.

## Progressive disclosure

Default views stay clean; detail reveals on demand (expand a row,
click into a record) rather than being crammed into the default view
or hidden behind unnecessary navigation.

## No dead screens

Every screen answers "what can I do here?" - actions are always
present and obvious: accept shift, call, message, navigate, open
visit, view client, upload document. A screen that only displays data
with nothing to do about it is a screen that needs an action added.

## Capacity first

Any workforce or client screen involving hours/authorizations shows
desired, scheduled, remaining, target, and gap immediately - never
something the user has to calculate mentally from raw numbers
elsewhere on the page.

## Color rules

Green = healthy. Blue = informational. Yellow = needs attention.
Orange = action required. Red = critical. Gray = inactive. Color is
never the only signal - always pair it with an icon or text label, for
accessibility and clarity.

## One-click / two-click rule

Everything reachable in at most 2 clicks from wherever the user is.
Never more.

## Search everywhere

Global search should find a client, caregiver, phone number,
diagnosis, authorization, document, visit, invoice, shift, skill, or
language - anything in the system, from one search box.

## Zero duplicate entry

If a piece of data already exists somewhere (an address, a diagnosis),
it's reused, never re-typed. Any place that could ask for the same
information twice should instead reference the existing record.

## Mobile-first thinking

Every screen works on desktop, tablet, and phone without a redesign.
Build for the smallest viewport's constraints from the start rather
than retrofitting responsiveness later.

---

## Current implementation status

This section tracks how much of the system above is actually built, so
it stays honest rather than aspirational.

**Built (Increment 15):**

- Action Center on the Overview page, computed from real data
  (shifts needing a status update, shifts happening today, active
  clients with no upcoming shifts, pending invitations). Nothing here
  is a placeholder - if a signal isn't backed by real data, it doesn't
  appear.
- Overview leads with the Action Center, not architecture talk.

**Built (Increment 16):**

- Sortable, filterable lists on Clients, Schedule, Access, and Audit -
  click a column header to sort (toggles ascending/descending), a
  search box filters by the fields relevant to that list (name/phone/
  email for clients, client/caregiver for shifts, name for members,
  who/action/record for audit entries). Client-side only - see
  `apps/web/src/lib/use-table-controls.ts` for why that's the right
  call at this data volume.

**Built (Increment 17):**

- Caregiver weekly hour targets. Each active member can have a
  `target_hours_per_week` set (0-168, optional) via
  `set_caregiver_weekly_target()`. `get_caregiver_hours()` returns
  scheduled + completed shift hours per caregiver for a given week,
  computed from real shift data (not estimated). Surfaced two places:
  a "Caregiver hours this week" table on the Schedule page (shows
  target/scheduled/gap per caregiver, editable inline for anyone with
  `shifts.update`), and a new critical-toned Action Center signal
  ("Caregivers over their weekly hour target") that links back to the
  Schedule page. Week boundaries are Monday-start, local time (see
  `apps/web/src/lib/week.ts`).

**Built (Increment 18):**

- Caregiver credentials. Free-text `credential_type` (CPR, background
  check, TB test, license - whatever an agency tracks) with optional
  issued/expiry dates per caregiver. Status (no expiration / active /
  expiring soon / expired) is derived at read time, never stored, so it
  can't drift stale. Surfaced on a new `/credentials` page (add, edit,
  remove for those with `credentials.update`; everyone can see their own
  regardless of permission, same carve-out pattern as shifts and hours)
  and as a critical-toned Action Center signal, "Credentials expiring or
  expired."

**Not yet built** (needs a data model before it can be real, not
faked):

- Authorization tracking and utilization (no `authorizations` table)
- Incident tracking
- CareScore / GeoScore / any scoring model
- Record-level header pattern (KPI header + tabs) on Clients/Schedule
- Resizable list columns (sortable/filterable are done; resizable
  isn't)
- Global search (per-page search exists; nothing searches everything
  at once yet)
- Distance/geo data

Building any of these into the Action Center or record layouts before
the underlying table exists would mean showing fabricated numbers -
that's worse than not having the feature yet, so each one waits for its
data model to be designed first.
