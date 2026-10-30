#!/usr/bin/env python3
"""V4/V5 invitation-acceptance checks (migration 0087: M-1, L-1, L-2, L-3): READ-ONLY (GET routes only) through the deployed API Lambda, with REAL TEST accounts named by Cognito sub.
Nothing is created, changed or deleted; no e-mail is sent; no POST route is called; no token, e-mail address or staff data is printed (only status codes, roles and agency short names).
The Owner performs the WRITES in the browser (invite, accept, set inactive); this script only READS the effect before and after each one.

  python3 invitation_checks_v4.py --client-id <id> --owner-sub <sub> --invitee-sub <sub> --phase before
      The Owner has invited the invitee's EXISTING e-mail (an account that already belongs to a DIFFERENT agency) and the invitee has NOT accepted yet:
        1. the Owner holds organization_owner in exactly one agency; the invitee belongs to a different agency only (they are an existing account);
        2. the invitee's GET /v1/me lists NO membership in the Owner's agency (M-1: nothing granted) and lists the Owner's agency under pendingInvitations with the expected role (--expect-role);
        3. the invitee is refused (403 or 404, no data) on the four staff GET routes of the Owner's agency;
        4. the pending invitation exposes only agency name and role (no e-mail, no person name).
  python3 invitation_checks_v4.py --client-id <id> --owner-sub <sub> --invitee-sub <sub> --phase after
      The invitee accepted in the browser: they now hold the expected role in the Owner's agency, pendingInvitations is empty for it, and their own agency is unchanged.
  python3 invitation_checks_v4.py --client-id <id> --owner-sub <sub> --invitee-sub <sub> --phase inactive
      The Owner set the invitee's staff profile inactive (L-3): the invitee no longer has the membership in the Owner's agency (GET /v1/me) and is refused on the staff routes; their own agency is unchanged.
Exit 0 = every check passed; 1 = a check failed; 2 = usage.
"""
import argparse
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "infra", "aws", "slice"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "..", "infra", "aws", "slice"))
import smoke  # noqa: E402

ROUTES = ["GET /v1/staff-types", "GET /v1/staff", "GET /v1/role-permissions", "GET /v1/staff-audit"]
DATA_KEYS = ("staff", "staffTypes", "permissions", "events", "members", "audit")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client-id", required=True)
    p.add_argument("--pool", default=smoke.POOL)
    p.add_argument("--owner-sub", required=True)
    p.add_argument("--invitee-sub", required=True)
    p.add_argument("--phase", required=True, choices=["before", "after", "inactive"])
    p.add_argument("--expect-role", default="read_only", help="the role the Owner chose in the invitation (default read_only)")
    p.add_argument("--local-invoker", help="test this script against a local handler")
    a = p.parse_args()
    inv = smoke.Invoker(types.SimpleNamespace(mode="local" if a.local_invoker else "aws", pool=a.pool, local_invoker=a.local_invoker), a.client_id)
    check = smoke.check

    def me(sub):
        s, body = inv.call("GET /v1/me", sub)
        ms = [(m.get("organizationSlug"), m.get("role"), m.get("organizationId")) for m in (body or {}).get("memberships", [])] if isinstance(body, dict) else []
        pend = (body or {}).get("pendingInvitations") if isinstance(body, dict) else None
        return s, ms, pend

    def leaked(body):
        return isinstance(body, dict) and any(isinstance(body.get(k), list) and body.get(k) for k in DATA_KEYS)

    s, oms, _ = me(a.owner_sub)
    owner = [m for m in oms if m[1] == "organization_owner"]
    check("setup", "the named Owner holds organization_owner in exactly one agency (status %s)" % s, s == 200 and len(owner) == 1, "memberships: %s" % [(x[0], x[1]) for x in oms])
    if not owner:
        return finish()
    org = owner[0][2]
    s, ims, pend = me(a.invitee_sub)
    in_owner_org = [m for m in ims if m[2] == org]
    elsewhere = [m for m in ims if m[2] != org]
    check("setup", "the invitee is an existing account that belongs to a DIFFERENT agency (status %s, %d other membership(s))" % (s, len(elsewhere)), s == 200 and len(elsewhere) >= 1, "memberships: %s" % [(x[0], x[1]) for x in ims])
    check("setup", "GET /v1/me carries a pendingInvitations list (the 0087 API is deployed)", isinstance(pend, list), "pendingInvitations: %r" % (type(pend).__name__,))
    pend = pend if isinstance(pend, list) else []
    mine = [x for x in pend if x.get("organizationId") == org]

    if a.phase == "before":
        check("M-1", "the invitee has NO membership in the Owner's agency yet (nothing was granted by inviting)", len(in_owner_org) == 0, "memberships in the Owner's agency: %d" % len(in_owner_org))
        check("M-1", "the Owner's agency is listed as a pending invitation with role %s" % a.expect_role, len(mine) == 1 and mine[0].get("role") == a.expect_role, "pending: %s" % [(x.get("organizationName") and "named", x.get("role")) for x in pend])
        check("L-1", "the pending invitation carries only agency id, agency name and role (no e-mail, no person name)", all(set(x.keys()) <= {"organizationId", "organizationName", "role", "invitedAt"} for x in mine), "keys: %s" % [sorted(x.keys()) for x in mine])
        for route in ROUTES:
            st, body = inv.call(route, a.invitee_sub, query={"organizationId": org})
            check("M-1", "%s: the invitee asks for the Owner's agency -> %s (403 or 404, no data)" % (route, st), st in (403, 404) and not leaked(body), "status %s" % st)
        st, body = inv.call("GET /v1/staff", a.owner_sub, query={"organizationId": org})
        rows = (body or {}).get("staff", []) if isinstance(body, dict) else []
        pending_rows = [r for r in rows if r.get("accessStatus") == "invitation_pending"]
        check("M-1", "the Owner's staff list shows at least one person as Invited (invitation_pending)", st == 200 and len(pending_rows) >= 1, "status %s, invited rows %d" % (st, len(pending_rows)))
    elif a.phase == "after":
        got = [m for m in in_owner_org if m[1] == a.expect_role]
        check("M-1", "after acceptance the invitee holds %s in the Owner's agency" % a.expect_role, len(got) == 1, "memberships in the Owner's agency: %s" % [(x[0], x[1]) for x in in_owner_org])
        check("M-1", "the invitation is no longer pending", len(mine) == 0, "pending in the Owner's agency: %d" % len(mine))
        check("setup", "the invitee's own agency is unchanged (still a member of %d other agency(ies))" % len(elsewhere), len(elsewhere) >= 1)
        for route in ROUTES:
            st, body = inv.call(route, a.invitee_sub, query={"organizationId": org})
            check("M-1", "%s: the invitee now is a member, so %s is refused as a role without staff permission, not as a stranger -> %s" % (route, a.expect_role, st), st == 403 and not leaked(body), "status %s" % st)
    else:  # inactive
        check("L-3", "after the profile was set inactive the invitee has NO membership in the Owner's agency", len(in_owner_org) == 0, "memberships in the Owner's agency: %d" % len(in_owner_org))
        check("setup", "the invitee's own agency is unchanged", len(elsewhere) >= 1)
        for route in ROUTES:
            st, body = inv.call(route, a.invitee_sub, query={"organizationId": org})
            check("L-3", "%s: the invitee asks for the Owner's agency -> %s (403 or 404, no data)" % (route, st), st in (403, 404) and not leaked(body), "status %s" % st)
    return finish()


def finish():
    bad = [r for r in smoke.RESULTS if not r[2]]
    for area, name, ok, detail in smoke.RESULTS:
        if not ok:
            print("FAIL [%s] %s: %s" % (area, name, detail))
    print("\n%d checks, %d failed" % (len(smoke.RESULTS), len(bad)))
    print("INVITATION CHECKS PASSED" if not bad else "INVITATION CHECKS FAILED")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
