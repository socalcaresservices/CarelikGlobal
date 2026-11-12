#!/usr/bin/env python3
"""V4 (v3) for the staff-management release: READ-ONLY checks (GET routes only) through the deployed API Lambda, using REAL TEST accounts that the Owner names by Cognito sub.
Nothing is created, changed or deleted; no e-mail is sent; no POST route is called; no token, e-mail address or staff data is printed (only status codes, roles and agency short names).

  python3 staff_negative_checks_v3.py --client-id <id> --probe <sub> [<sub> ...]
      prints, for each sub, GET /v1/me: the status and (agency short name, role) pairs. Use it to learn who is Owner, Scheduler, Manager or Caregiver.
  python3 staff_negative_checks_v3.py --client-id <id> --owner-sub <sub> [--caregiver-sub <sub>] [--nonowner-sub <sub>]
      1. the named Owner really holds the organization_owner role, and gets 200 on the four staff GET routes (positive control: the routes work);
      2. a Caregiver (if named) and a non-Owner such as a Scheduler or Manager (if named) are refused with 403 on all four routes;
      3. the Owner asking for an agency id that does not exist gets 403 or 404 and no data (an agency the caller does not belong to);
      4. a request without organizationId is a 400.
Exit 0 = every check passed; 1 = a check failed (or the Owner is not an Owner); 2 = usage.
"""
import argparse
import os
import sys
import types
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "infra", "aws", "slice"))
import smoke  # noqa: E402

ROUTES = ["GET /v1/staff-types", "GET /v1/staff", "GET /v1/role-permissions", "GET /v1/staff-audit"]
DATA_KEYS = ("staff", "staffTypes", "permissions", "events", "members", "audit")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client-id", required=True)
    p.add_argument("--pool", default=smoke.POOL)
    p.add_argument("--probe", nargs="+", metavar="SUB")
    p.add_argument("--owner-sub")
    p.add_argument("--caregiver-sub")
    p.add_argument("--nonowner-sub")
    p.add_argument("--other-agency-subs", nargs="+", metavar="SUB", help="real accounts that belong to a DIFFERENT agency than the Owner's (cross-agency checks)")
    p.add_argument("--local-invoker", help="test this script against a local handler")
    a = p.parse_args()
    inv = smoke.Invoker(types.SimpleNamespace(mode="local" if a.local_invoker else "aws", pool=a.pool, local_invoker=a.local_invoker), a.client_id)
    check = smoke.check

    def memberships(sub):
        s, me = inv.call("GET /v1/me", sub)
        ms = [(m.get("organizationSlug"), m.get("role"), m.get("organizationId")) for m in (me or {}).get("memberships", [])] if isinstance(me, dict) else []
        return s, ms, me

    if a.probe:
        for sub in a.probe:
            s, ms, me = memberships(sub)
            print("%s... status %s: %s" % (sub[:8], s, [(slug, role) for slug, role, _ in ms] if ms else (me.get("error") if isinstance(me, dict) else me)))
        return 0
    if not a.owner_sub:
        p.print_usage(sys.stderr)
        return 2

    def leaked(body):
        return isinstance(body, dict) and any(isinstance(body.get(k), list) and body.get(k) for k in DATA_KEYS)

    s, ms, _ = memberships(a.owner_sub)
    owner = [m for m in ms if m[1] == "organization_owner"]
    check("setup", "the named Owner holds the organization_owner role in exactly one agency (status %s)" % s, s == 200 and len(owner) == 1, "memberships: %s" % [(x[0], x[1]) for x in ms])
    if not owner:
        return finish()
    org = owner[0][2]
    for route in ROUTES:
        st, body = inv.call(route, a.owner_sub, query={"organizationId": org})
        check("control", "%s: Owner -> %s (must be 200)" % (route, st), st == 200, "status %s" % st)
    for label, sub in (("Caregiver", a.caregiver_sub), ("non-Owner", a.nonowner_sub)):
        if not sub:
            print("  ....  %s not named: not checked" % label)
            continue
        st, sms, _ = memberships(sub)
        in_org = [m for m in sms if m[2] == org]
        check("setup", "the named %s is a member of the Owner's agency (status %s, role %s)" % (label, st, in_org[0][1] if in_org else "none"), st == 200 and len(in_org) == 1 and in_org[0][1] != "organization_owner")
        for route in ROUTES:
            st2, body = inv.call(route, sub, query={"organizationId": org})
            check("negative", "%s: %s -> %s (must be 403)" % (route, label, st2), st2 == 403 and not leaked(body), "status %s" % st2)
    for sub in (a.other_agency_subs or []):
        st, sms, _ = memberships(sub)
        theirs = [m for m in sms if m[2] != org]
        check("setup", "other-agency account %s... (status %s) belongs to a different agency only (%s)" % (sub[:8], st, [(m[0], m[1]) for m in sms]), st == 200 and bool(theirs) and len(theirs) == len(sms))
        for route in ROUTES:
            st2, body = inv.call(route, sub, query={"organizationId": org})
            check("cross-agency", "%s: %s... asks for the Owner's agency -> %s (403 or 404, no data)" % (route, sub[:8], st2), st2 in (403, 404) and not leaked(body), "status %s" % st2)
        other_org = theirs[0][2] if theirs else None
        if other_org:
            for route in ROUTES:
                st2, body = inv.call(route, a.owner_sub, query={"organizationId": other_org})
                check("cross-agency", "%s: Owner asks for %s...'s agency -> %s (403 or 404, no data)" % (route, sub[:8], st2), st2 in (403, 404) and not leaked(body), "status %s" % st2)
    unknown = str(uuid.uuid4())
    for route in ROUTES:
        st, body = inv.call(route, a.owner_sub, query={"organizationId": unknown})
        check("negative", "%s: Owner asks for an agency that is not theirs -> %s (403 or 404, no data)" % (route, st), st in (403, 404) and not leaked(body), "status %s" % st)
        st, body = inv.call(route, a.owner_sub, query={})
        check("negative", "%s: no organizationId -> %s (must be 400)" % (route, st), st == 400 and not leaked(body), "status %s" % st)
    return finish()


def finish():
    bad = [r for r in smoke.RESULTS if not r[2]]
    print("\n%d checks, %d failed" % (len(smoke.RESULTS), len(bad)))
    print("STAFF CHECKS PASSED" if not bad else "STAFF CHECKS FAILED")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
