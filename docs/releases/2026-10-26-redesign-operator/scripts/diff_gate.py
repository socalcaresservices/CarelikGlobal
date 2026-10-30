#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the TEST deployment of release 2026-10-26-redesign (upgrade 7870a04 to code commit fb491a5). Read-only: it compares a LIVE CloudFormation template with the
SYNTHESIZED one, as JSON files, prints every difference, and exits 0 only if EVERY difference is on the allow-list below. Anything else exits 1 and the operator STOPS.

  python3 diff_gate.py template --stack <one of the five Ogevia-prod-* stacks> --live LIVE.json --new NEW.json
      LIVE.json = `aws cloudformation get-template --stack-name S --template-stage Original --query TemplateBody --output json`; NEW.json = the synthesized template.

ALLOW-LIST (everything else is a violation)
  Every stack: Description, Parameters, Outputs, Conditions, Mappings, Rules, Transform equal; no resource replaced; CDK::Metadata ignored; the VALUE of the
  `ogevia:deployment-status` tag ignored (it carries the approval reference).
  Ogevia-prod-EvidenceStorage, -NetworkEgress, -WebHosting, -Observability: NO difference at all. (This is also how decision D2 is enforced: if the live CloudFront
  aliases, certificate, Cognito callback URLs or API CORS origins differ from the code, the difference shows here and stops the release.)
  Ogevia-prod-ServiceVerificationApi: exactly (1) the ONE staff API route ADDED by this upgrade, POST /v1/me/staff-invitations/{organizationId}/accept (JWT-authorized by the
  same authorizer and wired to the same integration as the existing routes; the other 13 staff routes are already live on TEST since the 7870a04 release) and (2) the API
  Handler's Code S3Key (and the asset path in its Metadata). Every other property must be identical. Nothing else: no IAM, role, policy, environment, permission, stage,
  authorizer, integration, CORS, rule, alarm, log or secret change; no route removed or altered.
Result words: DELTA (the release's difference, deploy it), NONE (identical: nothing to deploy), VIOLATION (stop).
Exit: 0 = DELTA or NONE with no violation; 1 = a violation; 2 = unreadable input (treated as a failure).
"""
import argparse, copy, json, sys
from collections import Counter

STACKS = ["Ogevia-prod-EvidenceStorage", "Ogevia-prod-NetworkEgress", "Ogevia-prod-WebHosting", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-Observability"]
API = "Ogevia-prod-ServiceVerificationApi"
SECTIONS = ["Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform", "AWSTemplateFormatVersion"]
HEX64 = set("0123456789abcdef")
NEW_ROUTE_KEYS = {"POST /v1/me/staff-invitations/{organizationId}/accept"}


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


def gate_template(stack, live, new):
    """Returns (violations, notes, result) where result is DELTA, NONE or None (violation)."""
    v, notes = [], []
    if stack not in STACKS:
        return ["no allow-list exists for stack '%s': only the five Ogevia-prod-* TEST stacks are known" % stack], [], None
    live, new = norm_tags(live), norm_tags(new)
    for sec in SECTIONS:
        if live.get(sec) != new.get(sec):
            v.append("template section %s differs" % sec)
    lr = {k: x for k, x in live["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: x for k, x in new["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    added = sorted(set(nr) - set(lr))
    removed = sorted(set(lr) - set(nr))
    for k in removed:
        v.append("resource REMOVED: %s (%s)" % (k, lr[k].get("Type")))
    changed_handler = False
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
            v.append("routes added that are not the 1 staff route this upgrade adds: %s" % extra)
        if missing:
            v.append("the staff route this upgrade adds is missing from the release: %s" % missing)
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
            notes.append("%d staff API route(s) added, each JWT-authorized like the existing routes" % len(new_routes))
    if stack == API and (changed_handler != bool(new_routes)):
        v.append("the Handler code asset and the staff route must change together (code changed: %s, routes added: %d)" % (changed_handler, len(new_routes)))
    if v:
        return v, notes, None
    if stack == API and changed_handler and len(new_routes) == len(NEW_ROUTE_KEYS):
        return v, notes, "DELTA"
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
    if result == "NONE" and a.stack == API:
        print("NOTHING TO DEPLOY: the live API stack already equals this release.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
