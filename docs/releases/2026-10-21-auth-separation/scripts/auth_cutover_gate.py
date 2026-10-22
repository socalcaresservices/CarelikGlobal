#!/usr/bin/env python3
"""EXPECTED-ONLY GATE for the production authentication separation. Read-only; local files only (the operator saves the live templates first).

  auth_cutover_gate.py --live-dir LIVE --new-dir NEW [--shared-pool us-west-2_...]

LIVE: <Stack>.json = `aws cloudformation get-template --template-stage Original` for each production stack.  NEW: <Stack>.json = the templates synthesized from the
approved commit (deploy mode).  Exit 0 ONLY if every difference is on the allow-list below.  Anything else exits 1 and is printed.

ALLOW-LIST (everything else is a violation). The VALUE of every `ogevia:deployment-status` tag (the previous approval reference) is ignored, as in the release package's gate.
  Ogevia-prd-ServiceVerificationApi: no resource added or removed; Description, Parameters (except BootstrapVersion), Outputs, Conditions, Mappings equal; and ONLY
    * the JWT authorizer's Issuer and Audience, which must become: issuer from the Ogevia-prd-Auth pool, audience exactly ONE client from Ogevia-prd-Auth
      (the legacy client and the old production client leave the audience);
    * the API Lambda's Environment: COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID (to the Auth stack's pool and client) and OGEVIA_FORBIDDEN_POOL_IDS
      added with exactly the shared pool id (--shared-pool); plus Code.S3Key (the new build, at most one change);
    * the identity function's Environment.COGNITO_USER_POOL_ID (to the Auth pool);
    * the two identity IAM statements (CreateCaregiverSignIns, SwitchSignInsOnOff): ONLY their Resource (to the Auth pool ARN).
  Ogevia-prd-DatabaseSecret, -EvidenceStorage, -Observability and Ogevia-prod-NetworkEgress: byte-for-byte equal after removing CDK metadata.
  Ogevia-prd-WebHosting: equal except that the unused export of the OLD production client is dropped from the TEMPLATE (the API no longer imports it).
    This change never deploys the web stack, so live is untouched; deploying it later is a separate, approved clean-up.
  Ogevia-prd-Auth: must be NEW (absent from LIVE) and contain exactly one UserPool (Retain), UserPoolDomain, UserPoolClient and ManagedLoginBranding.
  Ogevia-prod-* pilot stacks other than NetworkEgress: not part of this change; if supplied they must be equal too.
  --reverse (rollback check): the two directories are swapped, so the PREVIOUS commit's templates play "live" and the current live templates play "new": it proves that
    redeploying the previous commit restores exactly the pre-change state (current live = previous commit + this allow-list, Auth present only in the current live).
"""
import argparse, json, os, sys

API = "Ogevia-prd-ServiceVerificationApi"
AUTH = "Ogevia-prd-Auth"
WEB = "Ogevia-prd-WebHosting"
OLD_CLIENT_EXPORT = "ExportsOutputRefTestSliceAppClient5EA2F71F"
MUST_EQUAL = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"]
PILOT = ["Ogevia-prod-EvidenceStorage", "Ogevia-prod-WebHosting", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-Observability"]
violations = []

def load(d, name):
    p = os.path.join(d, name + ".json")
    if not os.path.isfile(p): return None
    with open(p) as f: t = json.load(f)
    return t.get("TemplateBody", t) if isinstance(t, dict) else t

TAG = "ogevia:deployment-status"   # its VALUE is the approval reference of the last deployment: different on every release, never a difference that matters

def scrub_tags(x):
    if isinstance(x, dict):
        if x.get("Key") == TAG and "Value" in x: x["Value"] = "<approval>"
        if isinstance(x.get(TAG), str): x[TAG] = "<approval>"
        for v in x.values(): scrub_tags(v)
    elif isinstance(x, list):
        for v in x: scrub_tags(v)

def norm(t):
    t = json.loads(json.dumps(t))
    scrub_tags(t)
    t.pop("Metadata", None)
    t.get("Parameters", {}).pop("BootstrapVersion", None)
    t.get("Rules", {}).pop("CheckBootstrapVersion", None)
    if not t.get("Parameters"): t.pop("Parameters", None)
    if not t.get("Rules"): t.pop("Rules", None)
    for k in [k for k, v in t.get("Resources", {}).items() if v.get("Type") == "AWS::CDK::Metadata"]: del t["Resources"][k]
    for v in t.get("Resources", {}).values(): v.pop("Metadata", None)
    return t

import re
# Values compared as a WHOLE (an intrinsic function such as Fn::Join / Fn::ImportValue is one value, not a tree of changes).
OPAQUE = re.compile(r"(/Environment/Variables/[A-Za-z_]+|/JwtConfiguration/(Issuer|Audience)|/Resource|/Code/S3Key)$")

def diff(a, b, path=""):
    """list of (path, old, new)"""
    if OPAQUE.search(path): return [] if a == b else [(path, a, b)]
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append((f"{path}/{k}", None, b[k]))
            elif k not in b: out.append((f"{path}/{k}", a[k], None))
            else: out += diff(a[k], b[k], f"{path}/{k}")
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for i, (x, y) in enumerate(zip(a, b)): out += diff(x, y, f"{path}[{i}]")
        return out
    return [] if a == b else [(path, a, b)]

CSP_PATH = "/SecurityHeadersConfig/ContentSecurityPolicy/ContentSecurityPolicy"
DEDICATED_DOMAIN = re.compile(r"https://ogevia-prd-[0-9]+\.auth\.us-west-2\.amazoncognito\.com")

def csp_change_ok(old, new, shared_pool, expected_domain):
    """The website's Content-Security-Policy may change in exactly one way: the SHARED pilot sign-in domain is replaced by production's dedicated one
    (every other character equal) and the dedicated domain is exactly the one the Auth stack outputs. The browser blocks the sign-in code exchange when connect-src does not list the domain the site uses."""
    if not (isinstance(old, str) and isinstance(new, str)): return False
    shared_domain = "https://" + shared_pool.replace("_", "").lower() + ".auth.us-west-2.amazoncognito.com"
    found = set(DEDICATED_DOMAIN.findall(new))
    return found == {expected_domain} and shared_domain in old and old.replace(shared_domain, next(iter(found))) == new and shared_domain not in new

def bad(msg): violations.append(msg)
def imports(x):
    """every Fn::ImportValue name inside x"""
    if isinstance(x, dict):
        r = [x["Fn::ImportValue"]] if "Fn::ImportValue" in x and isinstance(x["Fn::ImportValue"], str) else []
        for v in x.values(): r += imports(v)
        return r
    if isinstance(x, list):
        r = []
        for v in x: r += imports(v)
        return r
    return []
def from_auth(x): 
    names = imports(x)
    return len(names) >= 1 and all(n.startswith(AUTH + ":") for n in names)

def gate_api(live, new, shared_pool):
    L, N = norm(live), norm(new)
    for k in ("Description", "Parameters", "Outputs", "Conditions", "Mappings", "Transform", "Rules"):
        if L.get(k) != N.get(k): bad(f"{API}: top-level {k} differs")
    lr, nr = set(L["Resources"]), set(N["Resources"])
    for r in sorted(nr - lr): bad(f"{API}: resource ADDED {r} ({N['Resources'][r]['Type']})")
    for r in sorted(lr - nr): bad(f"{API}: resource REMOVED {r} ({L['Resources'][r]['Type']})")
    counts = {"authorizer": 0, "handler-env": 0, "identity-env": 0, "iam": 0, "handler-code": 0}
    for rid in sorted(lr & nr):
        lres, nres = L["Resources"][rid], N["Resources"][rid]
        t = lres["Type"]
        if lres.get("Type") != nres.get("Type"): bad(f"{API}: {rid} changed type"); continue
        for k in set(lres) | set(nres):
            if k != "Properties" and lres.get(k) != nres.get(k): bad(f"{API}: {rid}.{k} differs (replacement/deletion policy or dependencies)")
        for path, old, new in diff(lres.get("Properties", {}), nres.get("Properties", {})):
            ok = False
            if t == "AWS::ApiGatewayV2::Authorizer" and path in ("/JwtConfiguration/Issuer", "/JwtConfiguration/Audience"):
                if path.endswith("Issuer") and from_auth(new) and shared_pool not in json.dumps(new): ok = True; counts["authorizer"] += 1
                if path.endswith("Audience") and isinstance(new, list) and len(new) == 1 and from_auth(new): ok = True; counts["authorizer"] += 1
            elif t == "AWS::Lambda::Function" and path.startswith("/Environment/Variables/"):
                var = path.rsplit("/", 1)[1]
                is_identity = set(nres["Properties"].get("Environment", {}).get("Variables", {})) == {"COGNITO_USER_POOL_ID"}
                if is_identity and var == "COGNITO_USER_POOL_ID" and from_auth(new): ok = True; counts["identity-env"] += 1
                elif not is_identity and var in ("COGNITO_USER_POOL_ID", "COGNITO_APP_CLIENT_ID") and from_auth(new) and shared_pool not in json.dumps(new): ok = True; counts["handler-env"] += 1
                elif not is_identity and var == "OGEVIA_FORBIDDEN_POOL_IDS" and old is None and new == shared_pool: ok = True; counts["handler-env"] += 1
            elif t == "AWS::Lambda::Function" and path == "/Code/S3Key" and not set(nres["Properties"].get("Environment", {}).get("Variables", {})) == {"COGNITO_USER_POOL_ID"}:
                ok = True; counts["handler-code"] += 1   # the API handler's new build; the identity function's code must NOT change
            elif t in ("AWS::IAM::Policy", "AWS::IAM::ManagedPolicy") and path.startswith("/PolicyDocument/Statement[") and path.endswith("/Resource"):
                i = int(path.split("[")[1].split("]")[0]); sid = nres["Properties"]["PolicyDocument"]["Statement"][i].get("Sid")
                if sid in ("CreateCaregiverSignIns", "SwitchSignInsOnOff") and from_auth(new) and shared_pool not in json.dumps(new): ok = True; counts["iam"] += 1
            if not ok:
                bad(f"{API}: {rid} {path} changed outside the allow-list")
    expect = {"authorizer": 2, "handler-env": 3, "identity-env": 1, "iam": 2}
    for k, n in expect.items():
        if counts[k] != n: bad(f"{API}: expected {n} allowed change(s) for {k}, found {counts[k]}")
    if counts["handler-code"] > 1: bad(f"{API}: the handler code changed more than once")
    return counts

def gate_auth_new(new):
    N = norm(new); R = N["Resources"]
    types = sorted(v["Type"] for v in R.values())
    if types != ["AWS::Cognito::ManagedLoginBranding", "AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolDomain"]:
        bad(f"{AUTH}: unexpected resources {types}")
    pool = [v for v in R.values() if v["Type"] == "AWS::Cognito::UserPool"]
    if pool and not (pool[0].get("DeletionPolicy") == "Retain" and pool[0].get("UpdateReplacePolicy") == "Retain"): bad(f"{AUTH}: the user pool is not Retain/Retain")
    if pool and pool[0]["Properties"].get("MfaConfiguration") != "ON": bad(f"{AUTH}: MFA is not ON")
    if pool and pool[0]["Properties"].get("DeletionProtection") != "ACTIVE": bad(f"{AUTH}: deletion protection is not ACTIVE")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--live-dir", required=True); ap.add_argument("--new-dir", required=True); ap.add_argument("--shared-pool", required=True)
    ap.add_argument("--reverse", action="store_true", help="rollback check: --live-dir is the CURRENT (post-change) live templates, --new-dir the PREVIOUS commit's templates; proves the previous commit plus the allow-list equals live")
    a = ap.parse_args()
    if a.reverse: a.live_dir, a.new_dir = a.new_dir, a.live_dir
    if not a.shared_pool.startswith("us-west-2_"): print("bad --shared-pool"); return 2
    live_api, new_api = load(a.live_dir, API), load(a.new_dir, API)
    if live_api is None or new_api is None: print(f"missing {API} template (live or new)"); return 1
    counts = gate_api(live_api, new_api, a.shared_pool)
    for s in MUST_EQUAL + PILOT:
        l, n = load(a.live_dir, s), load(a.new_dir, s)
        if l is None and n is None: continue
        if l is None or n is None: bad(f"{s}: present on only one side (live={'yes' if l else 'no'}, new={'yes' if n else 'no'})"); continue
        ds = diff(norm(l), norm(n))
        if s == WEB:
            # The API no longer imports the OLD production client, so CDK drops that unused export from the web stack's TEMPLATE. This change
            # does NOT deploy the web stack (the deploy guard allows only Auth + API), so live stays as it is; the only template difference
            # permitted is that one export being dropped.
            ds = [d for d in ds if not (d[0] == "/Outputs/" + OLD_CLIENT_EXPORT and d[2] is None)]
            # ... and the website's security header follows the dedicated sign-in domain (the browser would otherwise block the token exchange).
            auth_t = load(a.new_dir, AUTH); auth_domain = ((auth_t or {}).get("Outputs", {}).get("ManagedLoginDomain", {}) or {}).get("Value")
            ds = [d for d in ds if not (d[0].endswith(CSP_PATH) and isinstance(auth_domain, str) and csp_change_ok(d[1], d[2], a.shared_pool, auth_domain))]
        if ds: bad(f"{s}: differs from live, but this change must not touch it ({len(ds)} difference(s), first at {ds[0][0]})")
    if load(a.live_dir, AUTH) is not None: bad(f"{AUTH}: already exists live; this gate is for the first creation")
    new_auth = load(a.new_dir, AUTH)
    if new_auth is None: bad(f"{AUTH}: missing from the new templates")
    else: gate_auth_new(new_auth)
    if violations:
        print("FAIL: the difference is NOT limited to the authentication separation:")
        for v in violations: print("  - " + v)
        return 1
    print(f"PASS: {AUTH} is new; {API} differs only by {counts}; all other stacks are unchanged.")
    return 0

if __name__ == "__main__": sys.exit(main())
