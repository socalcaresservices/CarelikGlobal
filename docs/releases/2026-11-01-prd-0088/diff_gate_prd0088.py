#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the PRODUCTION API-stack deployment of 0086-0088 (Ogevia-prd-ServiceVerificationApi). Derived from the pilot gate diff_gate_0086.py (sha256 4e86f8d5...), with the 22 production routes (14 staff + 8 readiness) instead of the pilot's 8.
Read-only: compares two CloudFormation templates (JSON files) and exits 0 only if EVERY difference is on the allow-list below.

  python3 diff_gate_0086.py --live LIVE.json --new NEW.json [--expect pre|post]
      LIVE.json = `aws cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json`
      NEW.json  = the synthesized Ogevia-prd-ServiceVerificationApi.template.json
      --expect pre  (default) the 22 new routes must be ADDED (the release is not deployed yet)
      --expect post           NO difference at all (the release is deployed); used after the deployment

ALLOW-LIST for --expect pre:
  * exactly these 22 AWS::ApiGatewayV2::Route resources are ADDED (by RouteKey), nothing else is added or removed;
  * the Lambda function whose logical id starts with `Handler` may change ONLY Properties.Code.S3Key and Metadata `aws:asset:path` (the new code asset);
  * everything else is identical: every other resource (IAM, permissions, integrations, authorizer, log groups, events), Parameters, Outputs, Conditions, Mappings,
    Rules, Transform, Description. AWS::CDK::Metadata is ignored; the value of the `ogevia:deployment-status` tag is ignored (it carries the approval reference).
Any other difference: exit 1 and the Operator STOPS. Nothing here talks to AWS.
"""
import argparse, copy, json, sys
from collections import Counter

NEW_ROUTES = {
    "GET /v1/staff-types",
    "POST /v1/staff-types",
    "POST /v1/staff-types/{staffTypeId}/rename",
    "POST /v1/staff-types/{staffTypeId}/active",
    "GET /v1/staff",
    "POST /v1/staff",
    "POST /v1/staff/{profileId}",
    "POST /v1/staff-members/{userId}/profile",
    "POST /v1/staff/{profileId}/invitation",
    "POST /v1/staff/{profileId}/invitation/resend",
    "POST /v1/staff-roles/{userId}",
    "GET /v1/role-permissions",
    "GET /v1/staff-audit",
    "POST /v1/me/staff-invitations/{organizationId}/accept",
    "GET /v1/caregivers/{caregiverRecordId}/readiness",
    "POST /v1/caregivers/{caregiverRecordId}/approve",
    "POST /v1/caregivers/{caregiverRecordId}/cpr-tb/extend",
    "GET /v1/caregivers/{caregiverRecordId}/cpr-tb/extensions",
    "GET /v1/compliance/settings",
    "POST /v1/compliance/settings",
    "POST /v1/caregivers/{caregiverRecordId}/contact",
    "POST /v1/caregivers/{caregiverRecordId}/signin-link",
}
SECTIONS = ["AWSTemplateFormatVersion", "Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform"]


def norm(x):
    if isinstance(x, dict):
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            for i in out:
                if i.get("Key") == "ogevia:deployment-status" and "Value" in i:
                    i["Value"] = "<APPROVAL>"
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x


def _short(x):
    t = x if isinstance(x, str) else json.dumps(x, sort_keys=True)
    return t if len(t) <= 110 else t[:107] + "..."


def diff_paths(l, n, path=""):
    """Human-readable paths where two JSON values differ (read-only; for the operator, it does not change the verdict)."""
    out = []
    if isinstance(l, dict) and isinstance(n, dict):
        for k in sorted(set(l) | set(n)):
            if k not in l: out.append("+ %s/%s: %s" % (path, k, _short(n[k])))
            elif k not in n: out.append("- %s/%s: %s" % (path, k, _short(l[k])))
            else: out += diff_paths(l[k], n[k], "%s/%s" % (path, k))
    elif isinstance(l, list) and isinstance(n, list):
        if len(l) == len(n) and any(isinstance(x, (dict, list)) for x in l + n) and all(isinstance(a, type(b)) for a, b in zip(l, n)):
            for i, (a, b) in enumerate(zip(l, n)): out += diff_paths(a, b, "%s[%d]" % (path, i))
        else:
            cl, cn = Counter(json.dumps(x, sort_keys=True) for x in l), Counter(json.dumps(x, sort_keys=True) for x in n)
            for item in sorted(set(cl) | set(cn)):
                d = cn[item] - cl[item]
                if d: out.append("%s %s[]: %s%s" % ("+" if d > 0 else "-", path, _short(json.loads(item)), " (x%d)" % abs(d) if abs(d) > 1 else ""))
            if not out and l != n: out.append("~ %s: same items, different order" % path)
    elif l != n:
        out.append("~ %s: %s -> %s" % (path, _short(l), _short(n)))
    return out


def load(path):
    with open(path) as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or not isinstance(t.get("Resources"), dict):
        raise ValueError("%s is not a CloudFormation template" % path)
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--expect", choices=["pre", "post"], default="pre")
    ap.add_argument("--allow-cors-add", default="", help="comma-separated origins the API resource's CorsConfiguration.AllowOrigins may GAIN (each exactly once), nothing else; only with --expect pre")
    a = ap.parse_args()
    live, new = load(a.live), load(a.new)
    bad = []
    for s in SECTIONS:
        if norm(live.get(s)) != norm(new.get(s)):
            bad.append("section %s differs" % s)
    lr = {k: v for k, v in live["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: v for k, v in new["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    removed = sorted(set(lr) - set(nr))
    added = sorted(set(nr) - set(lr))
    for k in removed:
        bad.append("REMOVED resource %s (%s)" % (k, lr[k].get("Type")))
    added_keys = set()
    for k in added:
        r = nr[k]
        rk = (r.get("Properties") or {}).get("RouteKey")
        if r.get("Type") == "AWS::ApiGatewayV2::Route" and rk in NEW_ROUTES:
            added_keys.add(rk)
        else:
            bad.append("UNEXPECTED added resource %s (%s %s)" % (k, r.get("Type"), rk or ""))
    if a.expect == "pre" and added_keys != NEW_ROUTES:
        bad.append("expected the %d new routes to be added; missing: %s" % (len(NEW_ROUTES), sorted(NEW_ROUTES - added_keys)))
    if a.expect == "post" and added:
        bad.append("expected NO difference after deployment, but %d resources would be added" % len(added))
    changed_handler = []
    cors_add = [o for o in a.allow_cors_add.split(",") if o] if a.expect == "pre" else []
    cors_allowed = []
    for k in sorted(set(lr) & set(nr)):
        l, n = norm(lr[k]), norm(nr[k])
        if l == n:
            continue
        if lr[k].get("Type") == "AWS::Lambda::Function" and k.startswith("Handler"):
            l2, n2 = json.loads(json.dumps(l)), json.loads(json.dumps(n))
            for d in (l2, n2):
                d.get("Properties", {}).get("Code", {}).pop("S3Key", None)
                d.get("Metadata", {}).pop("aws:asset:path", None)
            if l2 == n2:
                changed_handler.append(k)
                continue
        if cors_add and lr[k].get("Type") == "AWS::ApiGatewayV2::Api":
            l2, n2 = copy.deepcopy(l), copy.deepcopy(n)
            lo = (l2.get("Properties", {}).get("CorsConfiguration") or {}).pop("AllowOrigins", None)
            no = (n2.get("Properties", {}).get("CorsConfiguration") or {}).pop("AllowOrigins", None)
            key = lambda x: json.dumps(x, sort_keys=True)
            if l2 == n2 and isinstance(lo, list) and isinstance(no, list) and Counter(map(key, no)) == Counter(map(key, lo)) + Counter(map(key, cors_add)):
                cors_allowed.append((k, cors_add)); continue
        bad.append("CHANGED resource %s (%s)" % (k, lr[k].get("Type")))
        for line in diff_paths(l, n)[:12]: bad.append("      " + line)
    if a.expect == "post" and changed_handler:
        bad.append("expected NO difference after deployment, but the Handler code asset still differs")
    print("added: %d route(s) %s" % (len(added_keys), "(the %d expected)" % len(NEW_ROUTES) if added_keys == NEW_ROUTES else sorted(added_keys)))
    print("Handler code asset changed: %s" % (", ".join(changed_handler) or "no"))
    for k, adds in cors_allowed: print("Allowed CORS addition on %s: AllowOrigins gains exactly %s (nothing else on the resource differs)" % (k, adds))
    if bad:
        print("EXPECTED-ONLY: NO")
        for b in bad:
            print(("  VIOLATION " + b) if not b.startswith("      ") else b)
        return 1
    print("EXPECTED-ONLY: YES")
    return 0


if __name__ == "__main__":
    sys.exit(main())
