#!/usr/bin/env python3
"""READ-ONLY probe of the AWS pilot through its Lambda (draft; not yet run against AWS).

Called by pilot-preflight-readonly.sh --probe-lambda. It invokes the pilot Lambda with API-Gateway-shaped events carrying the
SYNTHETIC test manager's claims (IAM-gated, the same invoker as smoke.py) and sends ONLY GET routes. No GET route writes
(begin_request only sets session variables). It prints status codes and counts: no identifiers, no tokens, no secret values.

What it tells us
  * which migration generation the live DATABASE has, by whether the database function behind each probe route exists
    (a missing function is a 500 internal_error; a present function answers 200 or a permission refusal 403);
  * whether seed 03 is present: the Care Team record TEST-CG-02 and its weekly availability windows (expected 7).
It cannot read the exact ledger (count and max version): that needs the database (runbook).
"""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402

TEST_MG = "a0000000-0000-4000-8000-0000000000a9"   # synthetic test manager (infra/aws/slice/pilot-e2e/subs.env)
# (route, query, generation that introduced the database function behind it)
LADDER = [
    ("GET /v1/shifts", "0026"),
    ("GET /v1/availability/requests", "0039"),
    ("GET /v1/caregiver-services", "0040"),
    ("GET /v1/visit-rules", "0050"),
    ("GET /v1/open-shifts", "0051"),
]


def main():
    client_id = os.environ.get("PREFLIGHT_CLIENT_ID", "")
    if not client_id or client_id == "None":
        print("  STOP  no app client id (stack output TestAppClientId): cannot probe")
        return 1
    # PREFLIGHT_LOCAL_INVOKER exists only to rehearse this probe against a LOCAL database (see smoke.py local mode).
    local = os.environ.get("PREFLIGHT_LOCAL_INVOKER")
    args = types.SimpleNamespace(mode="local" if local else "aws", pool=smoke.POOL, local_invoker=local, age_cmd=None)
    inv = smoke.Invoker(args, client_id)
    s, me = inv.call("GET /v1/me", TEST_MG)
    orgs = [m for m in (me or {}).get("memberships", []) if m.get("organizationSlug") == smoke.TEST_ORG_SLUG]
    print("  INFO  GET /v1/me (synthetic test manager) -> %s; membership in %s: %s" % (s, smoke.TEST_ORG_SLUG, "yes" if orgs else "NO"))
    if s != 200 or not orgs:
        print("  STOP  the synthetic test manager is not seeded in the test agency (or the Lambda is not reachable): stop and report")
        return 1
    org = orgs[0]["organizationId"]
    top = None
    for route, gen in LADDER:
        query = {"organizationId": org}
        if route == "GET /v1/shifts":
            query.update({"from": "2026-01-01", "to": "2026-01-02"})
        s, body = inv.call(route, TEST_MG, query=query)
        present = s in (200, 403)
        if present:
            top = gen
        print("  %s  %-34s -> %s  (%s)" % ("INFO ", route, s, "database function present, generation %s or later" % gen if present else "database function MISSING or error: generation %s not applied" % gen))
    print("  INFO  highest generation fingerprint present: %s (the ledger itself can only be read from the database)" % (top or "none"))
    s, cg = inv.call("GET /v1/caregivers", TEST_MG, query={"organizationId": org})
    rec = next((c for c in (cg or {}).get("caregivers", []) if c.get("caregiverCode") == "TEST-CG-02"), None)
    if not rec:
        print("  INFO  seed 03: Care Team record TEST-CG-02 NOT found (seed 03 not applied, or the record was changed)")
    else:
        s, av = inv.call("GET /v1/availability", TEST_MG, query={"organizationId": org, "caregiverRecordId": rec["caregiverRecordId"]})
        a = (av or {}).get("availability")
        windows = a.get("weekly", []) if isinstance(a, dict) else []
        print("  INFO  seed 03: TEST-CG-02 found (status %s); weekly availability windows %s (expected 7); GET /v1/availability -> %s" % (rec.get("status"), len(windows), s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
