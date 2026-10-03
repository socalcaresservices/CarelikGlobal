#!/usr/bin/env python3
"""SCS pilot checks after deployment (standard library only, read-mostly).

Invokes the deployed Lambda directly (IAM-gated, like smoke.py) with the three
pilot identities and checks: each account resolves to exactly one organization
and role, each caregiver lists only their own clients, the multi-service client
offers both services, and neither the pilot nor the test-slice organization can
read the other's clients or visits. Creates nothing. SYNTHETIC data only.
"""
import argparse
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (same directory)

PILOT_SLUG = "scs-pilot-synthetic"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client-id", required=True)
    p.add_argument("--manager-sub", required=True)
    p.add_argument("--caregiver-a-sub", required=True)
    p.add_argument("--caregiver-b-sub", required=True)
    p.add_argument("--test-manager-sub", required=True)
    p.add_argument("--local-invoker", help="test this script against a local handler (see smoke.py local mode)")
    p.add_argument("--pool", default=smoke.POOL)
    args = p.parse_args()
    mode = "local" if args.local_invoker else "aws"
    inv = smoke.Invoker(types.SimpleNamespace(mode=mode, pool=args.pool, local_invoker=args.local_invoker), args.client_id)
    check = smoke.check

    orgs = {}
    for name, sub, role in (("manager", args.manager_sub, "manager"),
                            ("caregiver A", args.caregiver_a_sub, "caregiver"),
                            ("caregiver B", args.caregiver_b_sub, "caregiver")):
        s, me = inv.call("GET /v1/me", sub)
        ms = (me or {}).get("memberships", [])
        ok = s == 200 and len(ms) == 1 and ms[0].get("organizationSlug") == PILOT_SLUG and ms[0].get("role") == role
        check("pilot", "%s: exactly one membership, %s in %s" % (name, role, PILOT_SLUG), ok, "status %s" % s)
        if ms:
            orgs[name] = ms[0]["organizationId"]
    org = orgs.get("manager")
    if not org:
        return finish()

    def codes(sub, organization):
        s, body = inv.call("GET /v1/clients/assigned", sub, query={"organizationId": organization})
        return s, sorted(c["clientCode"] for c in (body or {}).get("clients", []))

    s, a = codes(args.caregiver_a_sub, org)
    check("pilot", "caregiver A lists exactly P-AAXRX, P-QAUF7", s == 200 and a == ["P-AAXRX", "P-QAUF7"], str(a))
    s, b = codes(args.caregiver_b_sub, org)
    check("pilot", "caregiver B lists exactly P-AHXN7", s == 200 and b == ["P-AHXN7"], str(b))
    s, body = inv.call("GET /v1/clients/assigned", args.caregiver_b_sub, query={"organizationId": org})
    client = next((c for c in (body or {}).get("clients", []) if c["clientCode"] == "P-AHXN7"), None)
    check("pilot", "assigned-clients response carries nextScheduledServiceId (0017)",
          client is not None and "nextScheduledServiceId" in client)
    if client:
        s, sv = inv.call("GET /v1/clients/{clientId}/services", args.caregiver_b_sub,
                         path={"clientId": client["clientId"]}, query={"organizationId": org})
        got = sorted(x["serviceCode"] for x in (sv or {}).get("services", []))
        check("pilot", "multi-service client offers PCS and RSP to caregiver B", got == ["PCS", "RSP"], str(got))

    # Cross-tenant, both directions.
    s, test_me = inv.call("GET /v1/me", args.test_manager_sub)
    test_org = next((m["organizationId"] for m in (test_me or {}).get("memberships", [])
                     if m.get("organizationSlug") == smoke.TEST_ORG_SLUG), None)
    if test_org:
        s, x = codes(args.manager_sub, test_org)
        check("pilot", "pilot manager cannot list test-slice clients", s in (403, 404) or x == [], "status %s %s" % (s, x))
        s, x = codes(args.caregiver_a_sub, test_org)
        check("pilot", "pilot caregiver cannot list test-slice clients", s in (403, 404) or x == [], "status %s %s" % (s, x))
    s, x = codes(args.test_manager_sub, org)
    check("pilot", "test-slice manager cannot list pilot clients", s in (403, 404) or x == [], "status %s %s" % (s, x))
    s, v = inv.call("GET /v1/visits", args.test_manager_sub, query={"organizationId": org})
    check("pilot", "test-slice manager cannot list pilot visits",
          s in (403, 404) or (s == 200 and not (v or {}).get("visits")), "status %s" % s)
    return finish()


def finish():
    failed = [r for r in smoke.RESULTS if not r[2]]
    print("\n%d pilot checks, %d passed, %d failed" % (len(smoke.RESULTS), len(smoke.RESULTS) - len(failed), len(failed)), flush=True)
    for r in failed:
        print("  FAILED: [%s] %s %s" % (r[0], r[1], r[3]), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
