#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the TEST API stack at the request-cleanup release (re-pin of diff_gate_ux.py, which allow-lists an older release's routes).
Read-only: compares two CloudFormation templates (JSON files) and exits 0 only if EVERY difference is on the allow-list. Talks to no AWS.

  python3 diff_gate_0109.py --live LIVE.json --new NEW.json --expect off|on|post
      LIVE.json = `aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json`
      NEW.json  = the synthesized Ogevia-prod-ServiceVerificationApi.template.json for the release commit (isolated TEST)
      --expect off   switch OFF: ONLY the Handler code asset may change; NO route is added or removed (259 -> 259)
      --expect on    switch ON : the Handler code asset may change AND exactly these 3 routes are ADDED (259 -> 262); nothing removed
      --expect post  after deployment: NO difference at all

Allow-list (off and on): the Lambda function whose logical id starts with `Handler` may change ONLY Properties.Code.S3Key / S3Bucket and Metadata `aws:asset:path`
(the new code asset; the bucket must be the CDK asset bucket). Everything else is identical: every other resource, Parameters, Outputs, Conditions, Mappings, Rules,
Transform, Description. AWS::CDK::Metadata is ignored; the value of the `ogevia:deployment-status` tag is ignored (it carries the approval reference).
Any other difference: exit 1 and the Operator STOPS.
"""
import argparse, json, sys

NEW_ROUTES = {
    "POST /v1/care-notifications/read",
    "POST /v1/documents/{documentId}/cancel",
    "POST /v1/document-types/{documentTypeId}/retire",
}
ASSET_BUCKET = "cdk-hnb659fds-assets-300094796789-us-west-2"
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


def load(path):
    with open(path) as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or not isinstance(t.get("Resources"), dict):
        raise ValueError("%s is not a CloudFormation template" % path)
    return t


def compare(live, new, expect):
    bad = []
    for s in SECTIONS:
        if norm(live.get(s)) != norm(new.get(s)):
            bad.append("section %s differs" % s)
    lr = {k: v for k, v in live["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: v for k, v in new["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    for k in sorted(set(lr) - set(nr)):
        bad.append("REMOVED resource %s (%s)" % (k, lr[k].get("Type")))
    added_keys = set()
    for k in sorted(set(nr) - set(lr)):
        r = nr[k]
        rk = (r.get("Properties") or {}).get("RouteKey")
        if expect == "on" and r.get("Type") == "AWS::ApiGatewayV2::Route" and rk in NEW_ROUTES:
            added_keys.add(rk)
        else:
            bad.append("UNEXPECTED added resource %s (%s %s)" % (k, r.get("Type"), rk or ""))
    if expect == "on" and added_keys != NEW_ROUTES:
        bad.append("expected the 3 new routes to be added; missing: %s" % sorted(NEW_ROUTES - added_keys))
    changed_handler = []
    for k in sorted(set(lr) & set(nr)):
        l, n = norm(lr[k]), norm(nr[k])
        if l == n:
            continue
        if lr[k].get("Type") == "AWS::Lambda::Function" and k.startswith("Handler"):
            l2, n2 = json.loads(json.dumps(l)), json.loads(json.dumps(n))
            for d in (l2, n2):
                d.get("Properties", {}).get("Code", {}).pop("S3Key", None)
                d.get("Properties", {}).get("Code", {}).pop("S3Bucket", None)
                d.get("Metadata", {}).pop("aws:asset:path", None)
                if not d.get("Metadata"):
                    d.pop("Metadata", None)
            if l2 == n2 and nr[k].get("Properties", {}).get("Code", {}).get("S3Bucket") == ASSET_BUCKET:
                changed_handler.append(k)
                continue
        bad.append("CHANGED resource %s (%s)" % (k, lr[k].get("Type")))
    if expect == "post" and (changed_handler or added_keys or set(nr) - set(lr)):
        bad.append("expected NO difference after deployment, but the templates still differ")
    return bad, added_keys, changed_handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--expect", choices=["off", "on", "post"], required=True)
    a = ap.parse_args()
    bad, added, changed = compare(load(a.live), load(a.new), a.expect)
    print("routes added: %d %s" % (len(added), sorted(added) if added else ""))
    print("Handler code asset changed: %s" % (", ".join(changed) or "no"))
    if bad:
        print("EXPECTED-ONLY: NO")
        for b in bad:
            print("  VIOLATION", b)
        return 1
    print("EXPECTED-ONLY: YES (%s)" % a.expect)
    return 0


if __name__ == "__main__":
    sys.exit(main())
