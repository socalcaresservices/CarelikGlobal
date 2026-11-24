#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the TEST API stack at a Release Train 2 stage (same rules as diff_gate_0112.py, with a per-stage allow-list).
Read-only: compares two CloudFormation templates (JSON files) and exits 0 only if EVERY difference is on the allow-list. Talks to no AWS.

  python3 diff_gate_rt2.py --stage notifications --live LIVE.json --new NEW.json --expect off|on|post
      LIVE.json = `aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json`
      NEW.json  = the synthesized Ogevia-prod-ServiceVerificationApi.template.json for the release commit (isolated TEST)
      --expect off   stage switch OFF: ONLY the code assets of the Handler* and IdentityHandler* functions may change; no route, rule or permission is added or removed
      --expect on    stage switch ON : the same code changes AND exactly the stage's additions (routes, schedule rule, its invoke permission) AND exactly the stage's
                     environment variables on the Handler. Nothing removed, nothing else changed.
      --expect post  after deployment: NO difference at all

Stage `stage2` (after stage 1 is live): 9 routes (7 texting, 2 service location), Handler env SMS_MODE=mock and SERVICE_LOCATION=on, new code assets; no new resource of any other kind.
Stage `notifications` (email NOT configured: no email function, no SES permission, no sender):
  10 routes, one AWS::Events::Rule with rate(5 minutes), one AWS::Lambda::Permission named NotifySweepAllowEventRule*, Handler env COVER_ALERT_ADDRESS_RULES=on.
Everything else must be identical: every other resource, Parameters, Outputs, Conditions, Mappings, Rules, Transform, Description.
AWS::CDK::Metadata is ignored; the value of the `ogevia:deployment-status` tag is ignored (it carries the approval reference). Any other difference: exit 1 and the operator STOPS.
"""
import argparse, json, sys

ASSET_BUCKET = "cdk-hnb659fds-assets-300094796789-us-west-2"
SECTIONS = ["AWSTemplateFormatVersion", "Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform"]
CODE_ONLY_PREFIXES = ("Handler", "IdentityHandler")
STAGES = {
    "stage2": {   # open-shift texting (mock sender) and the client service location; the notification schedule and permission from stage 1 are already live
        "routes": {
            "GET /v1/sms-settings", "POST /v1/sms-settings", "GET /v1/my-sms", "POST /v1/my-sms", "GET /v1/sms-oncall", "POST /v1/sms-oncall", "GET /v1/sms-history",
            "GET /v1/clients/{clientId}/service-location", "POST /v1/clients/{clientId}/service-location",
        },
        "schedules": set(),
        "permission_prefixes": (),
        "handler_env": {"SMS_MODE": "mock", "SERVICE_LOCATION": "on"},
    },
    "notifications": {
        "routes": {
            "GET /v1/cover-notification-history", "GET /v1/cover-notification-settings", "GET /v1/cover-office-audiences", "GET /v1/notification-center",
            "GET /v1/notification-preferences", "POST /v1/cover-notification-settings", "POST /v1/notification-center/mark", "POST /v1/notification-preferences",
            "POST /v1/offices/{officeId}/cover-audience", "POST /v1/shifts/{shiftId}/notify-cover",
        },
        "schedules": {"rate(5 minutes)"},
        "permission_prefixes": ("NotifySweepAllowEventRule",),
        "handler_env": {"COVER_ALERT_ADDRESS_RULES": "on"},
    },
}


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


def strip_code(d):
    d = json.loads(json.dumps(d))
    d.get("Properties", {}).get("Code", {}).pop("S3Key", None)
    d.get("Properties", {}).get("Code", {}).pop("S3Bucket", None)
    d.get("Metadata", {}).pop("aws:asset:path", None)
    if not d.get("Metadata"):
        d.pop("Metadata", None)
    return d


def compare(live, new, expect, stage):
    st = STAGES[stage]
    bad = []
    for s in SECTIONS:
        if norm(live.get(s)) != norm(new.get(s)):
            bad.append("section %s differs" % s)
    lr = {k: v for k, v in live["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: v for k, v in new["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    for k in sorted(set(lr) - set(nr)):
        bad.append("REMOVED resource %s (%s)" % (k, lr[k].get("Type")))
    routes, rules, perms = set(), set(), []
    for k in sorted(set(nr) - set(lr)):
        r = nr[k]; p = r.get("Properties") or {}; t = r.get("Type")
        if expect == "on" and t == "AWS::ApiGatewayV2::Route" and p.get("RouteKey") in st["routes"]:
            routes.add(p["RouteKey"])
        elif expect == "on" and t == "AWS::Events::Rule" and p.get("ScheduleExpression") in st["schedules"]:
            rules.add(p["ScheduleExpression"])
        elif expect == "on" and t == "AWS::Lambda::Permission" and k.startswith(st["permission_prefixes"]):
            perms.append(k)
        else:
            bad.append("UNEXPECTED added resource %s (%s %s)" % (k, t, p.get("RouteKey") or p.get("ScheduleExpression") or ""))
    if expect == "on":
        if routes != st["routes"]:
            bad.append("expected the %d routes of this stage; missing: %s" % (len(st["routes"]), sorted(st["routes"] - routes)))
        if rules != st["schedules"]:
            bad.append("expected exactly the schedule rule(s) %s" % sorted(st["schedules"]))
        if len(perms) != len(st["permission_prefixes"]):
            bad.append("expected exactly %d schedule invoke permission(s), found %d" % (len(st["permission_prefixes"]), len(perms)))
    changed = []
    env_added = {}
    for k in sorted(set(lr) & set(nr)):
        l, n = norm(lr[k]), norm(nr[k])
        if l == n:
            continue
        if lr[k].get("Type") == "AWS::Lambda::Function" and k.startswith(CODE_ONLY_PREFIXES):
            l2, n2 = strip_code(l), strip_code(n)
            if k.startswith("Handler") and expect == "on":
                lv = (l2.get("Properties", {}).get("Environment") or {}).get("Variables", {})
                nv = (n2.get("Properties", {}).get("Environment") or {}).get("Variables", {})
                added = {a: nv[a] for a in nv if a not in lv}
                if added == st["handler_env"] and all(nv.get(a) == lv.get(a) for a in lv) and len(nv) == len(lv) + len(added):
                    env_added[k] = added
                    n2["Properties"]["Environment"]["Variables"] = lv
            if l2 == n2 and nr[k].get("Properties", {}).get("Code", {}).get("S3Bucket") == ASSET_BUCKET:
                changed.append(k)
                continue
        bad.append("CHANGED resource %s (%s)" % (k, lr[k].get("Type")))
    if expect == "on" and not env_added:
        bad.append("expected the Handler environment to gain exactly %s" % st["handler_env"])
    if expect == "post" and (changed or set(nr) - set(lr)):
        bad.append("expected NO difference after deployment, but the templates still differ")
    return bad, routes, changed, env_added


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=sorted(STAGES))
    ap.add_argument("--live", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--expect", choices=["off", "on", "post"], required=True)
    a = ap.parse_args()
    bad, routes, changed, env = compare(load(a.live), load(a.new), a.expect, a.stage)
    print("routes added: %d %s" % (len(routes), sorted(routes) if routes else ""))
    print("function code assets changed: %s" % (", ".join(changed) or "no"))
    print("Handler environment added: %s" % (json.dumps(env) if env else "no"))
    if bad:
        print("EXPECTED-ONLY: NO")
        for b in bad:
            print("  VIOLATION", b)
        return 1
    print("EXPECTED-ONLY: YES (%s, %s)" % (a.stage, a.expect))
    return 0


if __name__ == "__main__":
    sys.exit(main())
