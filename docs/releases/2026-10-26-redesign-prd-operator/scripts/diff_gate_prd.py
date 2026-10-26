#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the PRODUCTION deployment of release 2026-10-26-redesign (staff management). Read-only: it compares a LIVE CloudFormation template with the
SYNTHESIZED (or bundled release) one, as JSON files, prints every difference, and exits 0 only if EVERY difference is on the allow-list below. Anything else exits 1 and the
operator STOPS. The allow-list was written from the production read-only capture of 2026-10-26 (p1-diff-report.sh), not from TEST.

  python3 diff_gate_prd.py template --stack <stack> --live LIVE.json --new NEW.json
      LIVE.json = `aws cloudformation get-template --stack-name S --template-stage Original --query TemplateBody --output json`; NEW.json = the synthesized template.

ALLOW-LIST (everything else is a violation)
  Every stack: Description, Parameters, Conditions, Mappings, Rules, Transform equal; no resource replaced or removed; CDK::Metadata ignored; the VALUE of the
  `ogevia:deployment-status` tag ignored (it carries the approval reference).
  Ogevia-prd-DatabaseSecret, -EvidenceStorage, -Observability and the shared Ogevia-prod-NetworkEgress: NO difference at all.
  Ogevia-prd-Auth: exactly the web app client's sign-in callback list gains "https://app.ogevia.com/auth/callback" and "https://admin.ogevia.com/auth/callback" and its
      sign-out list gains "https://app.ogevia.com/" and "https://admin.ogevia.com/" (appended in that order, nothing removed or reordered); every other property identical.   -> DELTA
  Ogevia-prd-ServiceVerificationApi: exactly (1) the 13 staff API routes ADDED (each JWT-authorized by the same authorizer and wired to the same integration as the existing
      routes), (2) the API Handler's Code S3Key (and the asset path in its Metadata), and (3) in the HTTP API resource the CORS AllowOrigins list gains exactly
      "https://app.ogevia.com" then "https://admin.ogevia.com" appended (every other property of that resource identical). Nothing else: no IAM, role, policy, environment,
      permission, stage, authorizer, integration, rule, alarm, log or secret change; no route removed or altered.                                                -> DELTA
  Ogevia-prd-WebHosting: no resource difference; the only template difference allowed is that the Output `ExportsOutputRefTestSliceAppClient5EA2F71F` (an export that the
      earlier template still carries and the release no longer has; the capture showed no stack imports it) is absent from the NEW template.                      -> EXPORT-ONLY
      This stack is NEVER deployed by the procedure: the web files are published to its bucket, the stack is left as it is.
Result words: DELTA (the release's difference, deploy it), NONE (identical: nothing to deploy), EXPORT-ONLY (WebHosting only; nothing to deploy), VIOLATION (stop).
Exit: 0 = DELTA, NONE or EXPORT-ONLY with no violation; 1 = a violation; 2 = unreadable input (treated as a failure).
"""
import argparse, copy, json, sys
from collections import Counter

AUTH = "Ogevia-prd-Auth"
API = "Ogevia-prd-ServiceVerificationApi"
WEB = "Ogevia-prd-WebHosting"
NONE_STACKS = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"]
STACKS = [AUTH, API, WEB] + NONE_STACKS
SECTIONS = ["Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform", "AWSTemplateFormatVersion"]
HEX64 = set("0123456789abcdef")
APP_ORIGIN, ADMIN_ORIGIN = "https://app.ogevia.com", "https://admin.ogevia.com"
NEW_CALLBACKS = ["https://app.ogevia.com/auth/callback", "https://admin.ogevia.com/auth/callback"]
NEW_LOGOUTS = ["https://app.ogevia.com/", "https://admin.ogevia.com/"]
WEB_REMOVED_OUTPUT = "ExportsOutputRefTestSliceAppClient5EA2F71F"
NEW_ROUTE_KEYS = {
    "GET /v1/staff-types", "POST /v1/staff-types", "POST /v1/staff-types/{staffTypeId}/rename", "POST /v1/staff-types/{staffTypeId}/active",
    "GET /v1/staff", "POST /v1/staff", "POST /v1/staff/{profileId}", "POST /v1/staff-members/{userId}/profile",
    "POST /v1/staff/{profileId}/invitation", "POST /v1/staff/{profileId}/invitation/resend", "POST /v1/staff-roles/{userId}",
    "GET /v1/role-permissions", "GET /v1/staff-audit",
}


def norm_tags(x):
    if isinstance(x, dict):
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm_tags(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm_tags(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            for i in out:
                if i.get("Key") == "ogevia:deployment-status" and "Value" in i:
                    i["Value"] = "<APPROVAL>"
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x


def load(path):
    with open(path) as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or "Resources" not in t:
        raise ValueError("%s is not a CloudFormation template" % path)
    return t


def blank(obj, path):
    cur = obj
    parts = path.split(".")
    for p in parts[:-1]:
        if not isinstance(cur, dict) or p not in cur:
            return
        cur = cur[p]
    if isinstance(cur, dict) and parts[-1] in cur:
        cur[parts[-1]] = "<ALLOWED>"


def canon(x):
    return json.dumps(x, sort_keys=True)


def list_gains_exactly(old, new, gained):
    """True if `new` is `old` followed by exactly the `gained` items, in that order (the lists may hold CloudFormation functions, so only == is used)."""
    return isinstance(old, list) and isinstance(new, list) and new == old + list(gained)


origins_gain_exactly = list_gains_exactly


def gate_template(stack, live, new):
    """Returns (violations, notes, result) where result is DELTA, NONE, EXPORT-ONLY or None (violation)."""
    v, notes = [], []
    if stack not in STACKS:
        return ["no allow-list exists for stack '%s': only %s are known" % (stack, ", ".join(STACKS))], [], None
    live, new = norm_tags(live), norm_tags(new)
    export_only = False
    for sec in SECTIONS:
        if live.get(sec) == new.get(sec):
            continue
        if sec == "Outputs" and stack == WEB:
            lo, no = dict(live.get("Outputs") or {}), dict(new.get("Outputs") or {})
            if WEB_REMOVED_OUTPUT in lo and WEB_REMOVED_OUTPUT not in no:
                lo.pop(WEB_REMOVED_OUTPUT)
                if lo == no:
                    export_only = True
                    notes.append("WebHosting: Output %s (an export no stack imports) is absent from the release template; the stack is NOT deployed, the difference stays" % WEB_REMOVED_OUTPUT)
                    continue
        v.append("template section %s differs" % sec)
    lr = {k: x for k, x in live["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: x for k, x in new["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    added = sorted(set(nr) - set(lr))
    removed = sorted(set(lr) - set(nr))
    for k in removed:
        v.append("resource REMOVED: %s (%s)" % (k, lr[k].get("Type")))
    changed_handler = False
    auth_changed = False
    cors_changed = False
    for k in sorted(set(lr) & set(nr)):
        a, b = lr[k], nr[k]
        if a == b:
            continue
        if a.get("Type") != b.get("Type"):
            v.append("resource %s changes TYPE (replacement): %s -> %s" % (k, a.get("Type"), b.get("Type")))
            continue
        if stack == API and a.get("Type") == "AWS::Lambda::Function" and k.startswith("Handler") and not k.startswith("IdentityHandler"):
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            for x in (a2, b2):
                blank(x, "Properties.Code.S3Key"); blank(x, "Metadata.aws:asset:path")
            if a2 != b2:
                v.append("Lambda %s changed beyond its code asset (S3Key / asset path): environment, role, runtime, memory, timeout or another setting differs" % k)
                continue
            old, nk = a["Properties"]["Code"]["S3Key"], b["Properties"]["Code"]["S3Key"]
            if not (isinstance(nk, str) and nk.endswith(".zip") and set(nk[:-4]) <= HEX64 and len(nk) == 68):
                v.append("Lambda %s: the new code S3Key '%s' is not a CDK asset key" % (k, nk))
            elif nk == old:
                v.append("Lambda %s: only the asset path changed, the code key did not" % k)
            else:
                changed_handler = True
                notes.append("Lambda %s code asset %s... -> %s..." % (k, old[:12], nk[:12]))
            continue
        if stack == API and a.get("Type") == "AWS::ApiGatewayV2::Api":
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            try:
                ao_a = a2["Properties"]["CorsConfiguration"]["AllowOrigins"]
                ao_b = b2["Properties"]["CorsConfiguration"]["AllowOrigins"]
            except (KeyError, TypeError):
                ao_a = ao_b = None
            if origins_gain_exactly(ao_a, ao_b, [APP_ORIGIN, ADMIN_ORIGIN]):
                b2["Properties"]["CorsConfiguration"]["AllowOrigins"] = ao_a
                if a2 == b2:
                    cors_changed = True
                    notes.append("HTTP API %s: CORS origins %s and %s added to the template; every other property identical" % (k, APP_ORIGIN, ADMIN_ORIGIN))
                    continue
        if stack == AUTH and a.get("Type") == "AWS::Cognito::UserPoolClient":
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            try:
                cb_a, cb_b = a2["Properties"]["CallbackURLs"], b2["Properties"]["CallbackURLs"]
                lo_a, lo_b = a2["Properties"]["LogoutURLs"], b2["Properties"]["LogoutURLs"]
            except (KeyError, TypeError):
                cb_a = cb_b = lo_a = lo_b = None
            if list_gains_exactly(cb_a, cb_b, NEW_CALLBACKS) and list_gains_exactly(lo_a, lo_b, NEW_LOGOUTS):
                b2["Properties"]["CallbackURLs"], b2["Properties"]["LogoutURLs"] = cb_a, lo_a
                if a2 == b2:
                    auth_changed = True
                    notes.append("Cognito app client %s: sign-in callbacks %s and sign-out URLs %s added; every other property identical" % (k, NEW_CALLBACKS, NEW_LOGOUTS))
                    continue
        v.append("resource CHANGED outside the allow-list: %s (%s)" % (k, a.get("Type")))
    new_routes = []
    for k in added:
        r = nr[k]
        if stack == API and r.get("Type") == "AWS::ApiGatewayV2::Route":
            new_routes.append(k)
        else:
            v.append("resource ADDED outside the allow-list: %s (%s)" % (k, r.get("Type")))
    if new_routes:
        keys = [nr[k]["Properties"].get("RouteKey") for k in new_routes]
        extra = sorted(set(keys) - NEW_ROUTE_KEYS)
        missing = sorted(NEW_ROUTE_KEYS - set(keys))
        if extra:
            v.append("routes added that are not the 13 staff routes: %s" % extra)
        if missing:
            v.append("staff routes missing from the release: %s" % missing)
        if len(keys) != len(set(keys)):
            v.append("a route key is added twice")
        live_routes = [x["Properties"] for x in lr.values() if x.get("Type") == "AWS::ApiGatewayV2::Route"]
        triples = Counter(canon([p.get("AuthorizationType"), p.get("AuthorizerId"), p.get("Target")]) for p in live_routes if p.get("AuthorizationType") == "JWT")
        if not triples:
            v.append("the live stack has no JWT-authorized route to compare the new routes with")
        else:
            usual = triples.most_common(1)[0][0]
            for k in new_routes:
                p = nr[k]["Properties"]
                if canon([p.get("AuthorizationType"), p.get("AuthorizerId"), p.get("Target")]) != usual:
                    v.append("new route %s (%s) is not JWT-authorized by the same authorizer and wired to the same integration as the existing routes" % (k, p.get("RouteKey")))
                extra_props = set(p) - {"ApiId", "RouteKey", "AuthorizationType", "AuthorizerId", "Target"}
                if extra_props:
                    v.append("new route %s has unexpected properties %s" % (k, sorted(extra_props)))
                if p.get("RouteKey", "").split(" ")[0] not in ("GET", "POST"):
                    v.append("new route %s uses a method other than GET or POST" % k)
        if not v:
            notes.append("%d staff API routes added, each JWT-authorized like the existing routes" % len(new_routes))
    if stack == API and (changed_handler != bool(new_routes)):
        v.append("the Handler code asset and the 13 routes must change together (code changed: %s, routes added: %d)" % (changed_handler, len(new_routes)))
    if stack == API and new_routes and not cors_changed:
        v.append("the HTTP API's CORS origins did not gain exactly %s and %s together with the routes" % (APP_ORIGIN, ADMIN_ORIGIN))
    if v:
        return v, notes, None
    if stack == API and changed_handler and cors_changed and len(new_routes) == len(NEW_ROUTE_KEYS):
        return v, notes, "DELTA"
    if stack == AUTH and auth_changed and not added and not removed:
        return v, notes, "DELTA"
    if stack == WEB and export_only and not added and not removed:
        return v, notes, "EXPORT-ONLY"
    if not notes and not added and not removed:
        return v, ["%s has NO difference from the live stack" % stack], "NONE"
    return v + ["the difference for %s is not the release's expected change" % stack], notes, None


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    t = sub.add_parser("template")
    t.add_argument("--stack", required=True); t.add_argument("--live", required=True); t.add_argument("--new", required=True)
    a = ap.parse_args(argv)
    try:
        v, notes, result = gate_template(a.stack, load(a.live), load(a.new))
    except (OSError, ValueError, KeyError, TypeError) as ex:
        print("VIOLATION cannot evaluate the input (%s): treated as a failure" % ex)
        print("EXPECTED-ONLY: NO. STOP.")
        return 2
    for n in notes:
        print("ALLOWED " + n)
    for x in v:
        print("VIOLATION " + x)
    if v:
        print("EXPECTED-ONLY: NO (%d violation(s)). STOP." % len(v))
        return 1
    print("EXPECTED-ONLY: YES (%s)" % result)
    if result == "NONE" and a.stack in (API, AUTH):
        print("NOTHING TO DEPLOY: the live %s stack already equals this release." % a.stack)
    return 0


if __name__ == "__main__":
    sys.exit(main())
