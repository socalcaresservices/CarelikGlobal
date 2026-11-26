#!/usr/bin/env python3
"""EXPECTED-ONLY gate for turning the TEST notification email function ON. Read-only: compares two stacks' CloudFormation templates (JSON files) and exits 0 only if EVERY difference is on the allow-list.

  python3 diff_gate_email.py --api-live A.json --api-new B.json --egress-live C.json --egress-new D.json --expect on|same|post
      --expect on    ServiceVerificationApi gains EXACTLY: one Lambda function named *-NotificationEmail, its log group, its managed policy and its role (keys starting Email*);
                     the API Handler's managed policy (HandlerPolicy*) gains EXACTLY one statement (Sid InvokeNotificationEmail, lambda:InvokeFunction on that one function);
                     the API Handler's environment gains EXACTLY EMAIL_FUNCTION_NAME and APP_ORIGIN (code assets of Handler*/IdentityHandler* may differ).
                     NetworkEgress: ONLY the Lambda VPC endpoint policy changes, gaining EXACTLY the ARN of that one function. Nothing removed, nothing else changed.
      --expect same  (the saved rollback assembly) NO change except the code assets of the Handler*/IdentityHandler* functions; the egress stack identical.
      --expect post  after deployment: NO difference at all in either stack.
AWS::CDK::Metadata is ignored; the value of the `ogevia:deployment-status` tag is ignored. Any other difference: exit 1 and the operator STOPS. Talks to no AWS.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import diff_gate_rt2 as g

NAME_SUFFIX = "-NotificationEmail"


def resources(t):
    return {k: v for k, v in t["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}


def compare_api(live, new, expect):
    bad = []
    for s in g.SECTIONS:
        if g.norm(live.get(s)) != g.norm(new.get(s)):
            bad.append("api: section %s differs" % s)
    lr, nr = resources(live), resources(new)
    for k in sorted(set(lr) - set(nr)):
        bad.append("api: REMOVED resource %s (%s)" % (k, lr[k].get("Type")))
    added = sorted(set(nr) - set(lr))
    fn_key = None
    if expect == "on":
        want = {"AWS::Lambda::Function": 1, "AWS::Logs::LogGroup": 1, "AWS::IAM::ManagedPolicy": 1, "AWS::IAM::Role": 1}
        got = {}
        for k in added:
            r = nr[k]; t = r.get("Type")
            if not k.startswith("Email") or t not in want:
                bad.append("api: UNEXPECTED added resource %s (%s)" % (k, t)); continue
            got[t] = got.get(t, 0) + 1
            if t == "AWS::Lambda::Function":
                fn_key = k
                name = (r.get("Properties") or {}).get("FunctionName", "")
                if not str(name).endswith(NAME_SUFFIX):
                    bad.append("api: the new function is not named *%s" % NAME_SUFFIX)
                if "VpcConfig" in (r.get("Properties") or {}):
                    bad.append("api: the email function must stay OUTSIDE the VPC")
        if got != want:
            bad.append("api: expected exactly one email function, log group, policy and role; found %s" % got)
    elif added:
        bad.append("api: unexpected added resources %s" % added)
    changed = []
    for k in sorted(set(lr) & set(nr)):
        l, n = g.norm(lr[k]), g.norm(nr[k])
        if l == n:
            continue
        t = lr[k].get("Type")
        if t == "AWS::Lambda::Function" and k.startswith(g.CODE_ONLY_PREFIXES):
            l2, n2 = g.strip_code(l), g.strip_code(n)
            if expect == "on" and k.startswith("Handler"):
                lv = (l2.get("Properties", {}).get("Environment") or {}).get("Variables", {})
                nv = (n2.get("Properties", {}).get("Environment") or {}).get("Variables", {})
                added_env = {a: nv[a] for a in nv if a not in lv}
                if set(added_env) == {"EMAIL_FUNCTION_NAME", "APP_ORIGIN"} and all(nv.get(a) == lv.get(a) for a in lv) and len(nv) == len(lv) + 2 \
                        and str(added_env["EMAIL_FUNCTION_NAME"]).endswith(NAME_SUFFIX) and str(added_env["APP_ORIGIN"]).startswith("https://"):
                    n2["Properties"]["Environment"]["Variables"] = lv
                    # CDK may also record the dependency on the new policy/function: only Email* keys
                    dep = n2.get("DependsOn"); ldep = l2.get("DependsOn")
                    if dep != ldep:
                        a_ = set(dep if isinstance(dep, list) else [dep] if dep else []); b_ = set(ldep if isinstance(ldep, list) else [ldep] if ldep else [])
                        if a_ >= b_ and all(str(x).startswith("Email") for x in a_ - b_):
                            n2["DependsOn"] = ldep
            if l2 == n2 and nr[k].get("Properties", {}).get("Code", {}).get("S3Bucket") == g.ASSET_BUCKET:
                changed.append(k); continue
        if expect == "on" and t == "AWS::IAM::ManagedPolicy" and k.startswith("HandlerPolicy") and fn_key:
            ls = lr[k]["Properties"]["PolicyDocument"]["Statement"]; ns = nr[k]["Properties"]["PolicyDocument"]["Statement"]
            extra = [s for s in ns if s not in ls]
            if len(ns) == len(ls) + 1 and all(s in ns for s in ls) and len(extra) == 1 and extra[0].get("Sid") == "InvokeNotificationEmail" \
                    and extra[0].get("Action") == "lambda:InvokeFunction" and extra[0].get("Effect") == "Allow" and extra[0].get("Resource") == {"Fn::GetAtt": [fn_key, "Arn"]}:
                same = json.loads(json.dumps(nr[k])); same["Properties"]["PolicyDocument"]["Statement"] = ls
                if g.norm(same) == g.norm(lr[k]):
                    continue
        bad.append("api: CHANGED resource %s (%s)" % (k, t))
    if expect == "post" and (changed or added):
        bad.append("api: expected NO difference after deployment")
    return bad


def compare_egress(live, new, expect, api_new):
    bad = []
    for s in g.SECTIONS:
        if g.norm(live.get(s)) != g.norm(new.get(s)):
            bad.append("egress: section %s differs" % s)
    lr, nr = resources(live), resources(new)
    if set(lr) != set(nr):
        bad.append("egress: resources added or removed: %s" % sorted(set(lr) ^ set(nr)))
    fn_name = None
    for r in resources(api_new).values():
        if r.get("Type") == "AWS::Lambda::Function" and str((r.get("Properties") or {}).get("FunctionName", "")).endswith(NAME_SUFFIX):
            fn_name = r["Properties"]["FunctionName"]
    for k in sorted(set(lr) & set(nr)):
        if g.norm(lr[k]) == g.norm(nr[k]):
            continue
        if expect == "on" and lr[k].get("Type") == "AWS::EC2::VPCEndpoint" and fn_name:
            ls = lr[k]["Properties"]["PolicyDocument"]["Statement"]; ns = nr[k]["Properties"]["PolicyDocument"]["Statement"]
            if len(ls) == len(ns) == 1:
                lres = ls[0]["Resource"] if isinstance(ls[0]["Resource"], list) else [ls[0]["Resource"]]
                nres = ns[0]["Resource"] if isinstance(ns[0]["Resource"], list) else [ns[0]["Resource"]]
                gained = [x for x in nres if x not in lres]
                if len(nres) == len(lres) + 1 and all(x in nres for x in lres) and len(gained) == 1 and str(gained[0]).endswith(":function:" + fn_name):
                    a, b = json.loads(json.dumps(ls[0])), json.loads(json.dumps(ns[0])); a.pop("Resource"); b.pop("Resource")
                    rest_l = json.loads(json.dumps(lr[k])); rest_n = json.loads(json.dumps(nr[k]))
                    rest_l["Properties"]["PolicyDocument"]["Statement"] = []; rest_n["Properties"]["PolicyDocument"]["Statement"] = []
                    if a == b and g.norm(rest_l) == g.norm(rest_n):
                        continue
        bad.append("egress: CHANGED resource %s (%s)" % (k, lr[k].get("Type")))
    return bad


def main():
    ap = argparse.ArgumentParser()
    for n in ("api-live", "api-new", "egress-live", "egress-new"):
        ap.add_argument("--" + n, required=True)
    ap.add_argument("--expect", choices=["on", "same", "post"], required=True)
    a = ap.parse_args()
    try:
        al, an, el, en = g.load(a.api_live), g.load(a.api_new), g.load(a.egress_live), g.load(a.egress_new)
    except Exception as e:  # noqa: BLE001
        print("STOP:", e); sys.exit(2)
    bad = compare_api(al, an, a.expect) + compare_egress(el, en, a.expect, an)
    if bad:
        print("EXPECTED-ONLY: NO (%s)" % a.expect)
        for b in bad:
            print("  -", b)
        sys.exit(1)
    print("EXPECTED-ONLY: YES (email, %s)" % a.expect)


if __name__ == "__main__":
    main()
