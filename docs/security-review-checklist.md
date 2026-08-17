# Security review checklist for schema changes

Required before merging any PR that adds or modifies a `SECURITY DEFINER`
function, an RLS policy, or a `GRANT`/`REVOKE` statement in
`supabase/migrations/`.

This exists because two real vulnerabilities already reached production
without it: `has_permission()`'s support-access bypass checked "is this
person a platform owner" and stopped there, with no check that a support
grant was actually active, for about two days
(`20260807000000_support_access.sql` →
`20260809021702_gate_has_permission_bypass_on_active_support_access.sql`);
and `start_ad_hoc_service_visit()` let any caregiver with an active
membership start and bill a visit for any client in the org, with no
check that they were actually assigned to that client, for about a day
(`20260816224000_caregiver_ad_hoc_visits.sql` →
`20260817054716_streamlined_access_model.sql`). Both were self-caught and
fixed quickly. Neither should have needed to be caught after merge.

## The checklist

For every new or modified `SECURITY DEFINER` function:

- [ ] **Does it validate that the target row belongs to the organization
      the caller claims?** A function that checks `has_permission(org_id,
      'x.manage')` and then acts on `target_user_id`/`target_client_id`
      without also confirming that row's `organization_id = org_id` lets
      an authorized-in-their-own-org caller reach into someone else's
      tenant. (This is exactly what `get_caregiver_location`/
      `set_caregiver_profile` got wrong before
      `20260728040000_isolation_audit_fixes.sql` fixed it.)
- [ ] **Does it require the specific relationship it implies, not just
      organization membership?** "Any caregiver in this org" is not the
      same authorization as "the caregiver assigned to this client." If
      the function's name or purpose implies an assignment, a schedule,
      or an ownership relationship, the function body must check that
      relationship explicitly, not just that the caller has a role.
- [ ] **Is `search_path` pinned** (`set search_path = public` or the
      narrowest schema list the function actually needs)?
- [ ] **Who is this granted to, and why?** `EXECUTE` is granted to
      `PUBLIC` by default when a function is created — an explicit
      `revoke all ... from public` followed by a deliberate `grant
      execute ... to <role>` is required. If the function is granted to
      `anon`, the PR description must state what token/slug/other secret
      gates it, since `anon` means "callable by anyone on the internet
      with no session."
- [ ] **Does it trust a client-supplied `organization_id`/`user_id` for
      anything other than as a row to re-validate?** The authoritative
      identity is always `auth.uid()` plus a lookup in
      `organization_memberships` — a parameter is a convenience for the
      query, never the authorization itself.

For every new or modified RLS policy:

- [ ] Does the policy's `USING`/`WITH CHECK` clause reference the row's
      own `organization_id`, not just `auth.uid()` in isolation? A policy
      that only checks "is this my own row" without an org join can let a
      caller write org-scoped data under an org they don't belong to (see
      the `caregiver_availability` fix in the same
      `isolation_audit_fixes` migration above).
- [ ] Is there already a permissive policy for this role/action on this
      table? Adding a second one is a correctness smell as often as it's
      a performance one — confirm the two policies are meant to be
      alternatives (either grants access), not that one was supposed to
      replace the other.

Reviewers: do not approve a PR touching any of the above without checking
every box or getting an explicit written justification in the PR
description for why a box doesn't apply.
