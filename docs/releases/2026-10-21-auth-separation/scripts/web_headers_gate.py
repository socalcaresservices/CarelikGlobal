#!/usr/bin/env python3
"""Expected-only gate for the FOLLOW-UP change: the production website's security header must allow production's own sign-in domain.

Found after the authentication separation was deployed (2026-10-22): the CloudFront response-headers policy still listed only the SHARED pilot domain in
connect-src, so the browser blocked the sign-in code exchange ("Could not reach the sign-in service"). The fix changes ONE value in ONE stack.

  python3 -I -B web_headers_gate.py --live-dir <dir with the LIVE templates of the seven stacks> --new-dir <dir with the packaged templates> --shared-pool us-west-2_...

PASS (exit 0) only when ALL of these hold:
  * Ogevia-prd-Auth, Ogevia-prd-ServiceVerificationApi and every other stack equal the new templates (nothing else changes, nothing else is redeployed);
  * Ogevia-prd-WebHosting differs from live by exactly: the Content-Security-Policy value (the shared domain replaced by the dedicated one the Auth stack outputs, every
    other character equal) and, optionally, the unused export of the old client;
  * the old-client export that CDK drops is imported by no live stack.
Standard library only; writes nothing; contacts nothing.
"""
import argparse, importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("auth_cutover_gate", os.path.join(HERE, "auth_cutover_gate.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

STACKS = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress", "Ogevia-prd-Auth"]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--live-dir", required=True); ap.add_argument("--new-dir", required=True); ap.add_argument("--shared-pool", required=True)
    a = ap.parse_args()
    if not a.shared_pool.startswith("us-west-2_"): print("bad --shared-pool"); return 2
    problems = []
    live = {s: g.load(a.live_dir, s) for s in STACKS}; new = {s: g.load(a.new_dir, s) for s in STACKS}
    for s in STACKS:
        if live[s] is None or new[s] is None: problems.append(f"{s}: missing ({'live' if live[s] is None else 'new'} template)")
    if problems: return fail(problems)
    auth_domain = (new[g.AUTH].get("Outputs", {}).get("ManagedLoginDomain", {}) or {}).get("Value")
    if not isinstance(auth_domain, str): return fail([f"{g.AUTH}: the new template has no literal ManagedLoginDomain output"])
    csp_changes = 0
    for s in STACKS:
        ds = g.diff(g.norm(live[s]), g.norm(new[s]))
        if s == g.WEB:
            other = []
            for d in ds:
                if d[0] == "/Outputs/" + g.OLD_CLIENT_EXPORT and d[2] is None: continue
                if d[0].endswith(g.CSP_PATH) and g.csp_change_ok(d[1], d[2], a.shared_pool, auth_domain): csp_changes += 1; continue
                other.append(d)
            ds = other
        if ds: problems.append(f"{s}: differs from live in a way this change does not allow ({len(ds)} difference(s), first at {ds[0][0]})")
    if csp_changes != 1: problems.append(f"{g.WEB}: expected exactly ONE security-header change (shared sign-in domain -> {auth_domain}), found {csp_changes}. If 0, it is already applied.")
    dropped = g.OLD_CLIENT_EXPORT
    users = [s for s in STACKS if any(n.endswith(":" + dropped) or n == dropped for n in g.imports(live[s]))]
    if users: problems.append(f"the old-client export is still imported by {users}; it must not be dropped")
    if problems: return fail(problems)
    print(f"PASS: only {g.WEB} changes, by one value: its Content-Security-Policy now allows {auth_domain} instead of the shared pilot domain. All other stacks are unchanged.")
    return 0

def fail(problems):
    print("FAIL: the difference is NOT limited to the website's security header:")
    for p in problems: print("  - " + p)
    return 1

if __name__ == "__main__": sys.exit(main())
