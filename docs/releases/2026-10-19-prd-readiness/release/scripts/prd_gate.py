#!/usr/bin/env python3
"""EXPECTED-ONLY GATE for Ogevia-prd-ServiceVerificationApi (production release, stage B). Read-only; local files only.
  prd_gate.py --live LIVE.json --new NEW.json [--allow-public-route 'GET /v1/public/...']...
LIVE = the stack's live template (aws cloudformation get-template --template-stage Original); NEW = the release template bundled in the package.
Exit 0 ONLY if every difference is on the allow-list below (written from the production baseline of 2026-10-20: 68 resources added, 31 properties changed); anything else exits 1.

ALLOW-LIST (everything else is a violation):
  Whole template: Description, Parameters (except BootstrapVersion), Outputs, Conditions, Mappings, Transform equal; CDK::Metadata and per-resource Metadata ignored; the VALUE of the
  `ogevia:deployment-status` tag ignored; no resource removed.
  Added resources: (1) exactly EXPECT_ROUTES_ADDED AWS::ApiGatewayV2::Route, each with AuthorizationType JWT and the existing authorizer, a Target on an integration that already
  exists live, and (unless named with --allow-public-route) never AuthorizationType NONE; (2) the ComplianceSweep EventBridge rule (rate(15 minutes), ENABLED, target = the Handler)
  and its Lambda invoke permission (principal events.amazonaws.com, source = that rule). Nothing else.
  Changed resources: Handler886CB40B (ONLY Code.S3Key, from the pinned live key to the pinned release key); IdentityHandler6F0A3417 (ONLY Code.S3Key, pinned old to pinned new, and
  Description, pinned old to pinned new); IdentityRole07BDF020 (ONLY Description, pinned old to pinned new); HandlerPolicy7544C855 (ONLY one added statement ClientDocumentObjects:
  Allow s3:GetObject/GetObjectVersion/PutObject on the production evidence bucket's */client-documents/*/*; every other statement identical, compared by Sid, order ignored);
  IdentityPolicyF3EE534F (ONLY one added statement SwitchSignInsOnOff: Allow cognito-idp:AdminDisableUser/AdminEnableUser on the one user pool). No other resource may change."""
import argparse, copy, json, sys

ACCOUNT = "300094796789"
BUCKET = f"ogevia-prd-signature-evidence-{ACCOUNT}-us-west-2"
POOL_ARN = f"arn:aws:cognito-idp:us-west-2:{ACCOUNT}:userpool/us-west-2_849AYz5J7"
LIVE_HANDLER_KEY = "4832b6ba4f8ff1b8706697326b0d76d3d96d5031265c0d6024ee10c1e194817c.zip"
NEW_HANDLER_KEY = "eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda.zip"
LIVE_IDENTITY_KEY = "e345075a65c98ef8fae929be46fb48be5c3c268702af0f409df509fb3634791b.zip"
NEW_IDENTITY_KEY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip"
LIVE_ID_DESC = "Ogevia caregiver invitations: Cognito AdminCreateUser/AdminGetUser only"
NEW_ID_DESC = "Ogevia identity: Cognito create/get/disable/enable of sign-ins on one pool"
LIVE_ROLE_DESC = "Ogevia caregiver invitation identity function (Cognito create/resend only)"
NEW_ROLE_DESC = "Ogevia identity function (Cognito create/resend, and switch a sign-in off or on)"
EXPECT_ROUTES_ADDED = 66
ADDED_STATEMENT_HANDLER = {"Sid": "ClientDocumentObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], "Resource": f"arn:aws:s3:::{BUCKET}/*/client-documents/*/*"}
ADDED_STATEMENT_IDENTITY = {"Sid": "SwitchSignInsOnOff", "Effect": "Allow", "Action": ["cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser"], "Resource": POOL_ARN}
SECTIONS = ["Description", "Outputs", "Conditions", "Mappings", "Transform", "AWSTemplateFormatVersion"]
V = []  # violations

def load(path):
    with open(path, encoding="utf-8") as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or "Resources" not in t:
        raise ValueError(f"{path} is not a CloudFormation template")
    return t

def norm(x):
    if isinstance(x, dict):
        if x.get("Key") == "ogevia:deployment-status" and "Value" in x:
            return {"Key": x["Key"], "Value": "<APPROVAL>"}
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x

def prep(t):
    t = norm(t)
    res = {k: {a: b for a, b in v.items() if a != "Metadata"} for k, v in t["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    params = {k: v for k, v in (t.get("Parameters") or {}).items() if k != "BootstrapVersion"}
    return res, {**{s: t.get(s) for s in SECTIONS}, "Parameters": params or None}

def bad(msg):
    V.append(msg)

def ref_names(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == "Ref" and isinstance(v, str):
                yield v
            else:
                yield from ref_names(v)
    elif isinstance(x, list):
        for i in x:
            yield from ref_names(i)

def only_changes(a, b, paths):
    """True if a and b differ only inside the given (path tuples); paths are removed from deep copies and the rest compared."""
    a, b = copy.deepcopy(a), copy.deepcopy(b)
    for p in paths:
        for d in (a, b):
            cur = d
            for k in p[:-1]:
                cur = cur.get(k, {}) if isinstance(cur, dict) else {}
            if isinstance(cur, dict):
                cur.pop(p[-1], None)
    return a == b

def get(d, *path):
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
    return d

def check_lambda(name, a, b, live_key, new_key, desc=None):
    if get(a, "Properties", "Code", "S3Key") != live_key:
        bad(f"{name}: the LIVE code asset key is {get(a, 'Properties', 'Code', 'S3Key')}, not the pinned {live_key}: production is not in the state the baseline recorded")
    if get(b, "Properties", "Code", "S3Key") != new_key:
        bad(f"{name}: the RELEASE code asset key is {get(b, 'Properties', 'Code', 'S3Key')}, not the pinned {new_key}")
    paths = [("Properties", "Code", "S3Key")]
    if desc:
        paths.append(("Properties", "Description"))
        if get(a, "Properties", "Description") != desc[0] or get(b, "Properties", "Description") != desc[1]:
            bad(f"{name}: the Description change is not the pinned one")
    if not only_changes(a, b, paths):
        bad(f"{name}: something other than {', '.join('.'.join(p) for p in paths)} differs")

def check_role(name, a, b):
    if get(a, "Properties", "Description") != LIVE_ROLE_DESC or get(b, "Properties", "Description") != NEW_ROLE_DESC:
        bad(f"{name}: the Description change is not the pinned one")
    if not only_changes(a, b, [("Properties", "Description")]):
        bad(f"{name}: something other than Properties.Description differs")

def check_policy(name, a, b, added):
    da, db = get(a, "Properties", "PolicyDocument") or {}, get(b, "Properties", "PolicyDocument") or {}
    sa, sb = da.get("Statement"), db.get("Statement")
    if not isinstance(sa, list) or not isinstance(sb, list):
        bad(f"{name}: a policy document has no Statement list"); return
    ka, kb = [s.get("Sid") for s in sa], [s.get("Sid") for s in sb]
    if None in ka or None in kb or len(set(ka)) != len(ka) or len(set(kb)) != len(kb):
        bad(f"{name}: statements must have unique Sids to be compared"); return
    ma, mb = {s["Sid"]: s for s in sa}, {s["Sid"]: s for s in sb}
    if set(mb) - set(ma) != {added["Sid"]}:
        bad(f"{name}: the statements added are {sorted(set(mb) - set(ma))}, not exactly [{added['Sid']}]")
    if set(ma) - set(mb):
        bad(f"{name}: statements REMOVED: {sorted(set(ma) - set(mb))}")
    for sid in set(ma) & set(mb):
        if ma[sid] != mb[sid]:
            bad(f"{name}: statement {sid} CHANGED")
    if mb.get(added["Sid"]) != added:
        bad(f"{name}: the added statement {added['Sid']} is not exactly the expected one: {json.dumps(mb.get(added['Sid']), sort_keys=True)}")
    if not only_changes(a, b, [("Properties", "PolicyDocument", "Statement")]):
        bad(f"{name}: something other than the Statement list differs")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--live", required=True); ap.add_argument("--new", required=True); ap.add_argument("--allow-public-route", action="append", default=[])
    args = ap.parse_args()
    try:
        live, new = load(args.live), load(args.new)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"unreadable input: {e}"); return 2
    ra, sa = prep(live); rb, sb = prep(new)
    for s in SECTIONS + ["Parameters"]:
        if sa[s] != sb[s]:
            bad(f"template section {s} differs")
    removed = sorted(set(ra) - set(rb))
    if removed:
        bad(f"resources REMOVED: {removed}")
    added = sorted(set(rb) - set(ra))
    routes = [k for k in added if rb[k].get("Type") == "AWS::ApiGatewayV2::Route"]
    others = [k for k in added if k not in routes]
    if len(routes) != EXPECT_ROUTES_ADDED:
        bad(f"{len(routes)} routes added, expected exactly {EXPECT_ROUTES_ADDED}")
    authorizers = {k for k, v in ra.items() if v.get("Type") == "AWS::ApiGatewayV2::Authorizer"}
    integrations = {k for k, v in ra.items() if v.get("Type") == "AWS::ApiGatewayV2::Integration"}
    public_added = []
    for k in routes:
        p = rb[k].get("Properties", {})
        at, key = p.get("AuthorizationType"), p.get("RouteKey")
        if at == "NONE":
            public_added.append(key)
            if key not in args.allow_public_route:
                bad(f"route {key} is added WITHOUT authorization (AuthorizationType NONE) and is not on --allow-public-route")
        elif at != "JWT":
            bad(f"route {key}: AuthorizationType is {at!r}, expected JWT")
        else:
            aid = (p.get("AuthorizerId") or {}).get("Ref")
            if aid not in authorizers:
                bad(f"route {key}: its authorizer {aid!r} is not an existing live authorizer")
        refs = [r for r in ref_names(p.get("Target")) if r in rb]
        if not refs or not all(r in integrations for r in refs):
            bad(f"route {key}: its target is not an integration that already exists live ({refs})")
    sweep = [k for k in others if rb[k].get("Type") == "AWS::Events::Rule"]
    perm = [k for k in others if rb[k].get("Type") == "AWS::Lambda::Permission" and k.startswith("ComplianceSweepAllowEventRule")]
    if len(sweep) != 1 or not sweep[0].startswith("ComplianceSweep") or len(perm) != 1 or len(others) != 2:
        bad(f"the non-route additions are {others}, expected exactly the ComplianceSweep rule and its invoke permission")
    else:
        r = rb[sweep[0]].get("Properties", {})
        if r.get("ScheduleExpression") != "rate(15 minutes)" or r.get("State") != "ENABLED" or [get(t, "Arn", "Fn::GetAtt") for t in r.get("Targets", [])] != [["Handler886CB40B", "Arn"]]:
            bad("the ComplianceSweep rule is not rate(15 minutes), ENABLED, targeting only the Handler")
        pp = rb[perm[0]].get("Properties", {})
        if pp.get("Principal") != "events.amazonaws.com" or pp.get("Action") != "lambda:InvokeFunction" or get(pp, "FunctionName", "Fn::GetAtt") != ["Handler886CB40B", "Arn"] or get(pp, "SourceArn", "Fn::GetAtt") != [sweep[0], "Arn"]:
            bad("the ComplianceSweep invoke permission is not events.amazonaws.com -> the Handler, sourced from the rule")
    allowed_changed = {"Handler886CB40B", "IdentityHandler6F0A3417", "IdentityRole07BDF020", "HandlerPolicy7544C855", "IdentityPolicyF3EE534F"}
    changed = sorted(k for k in set(ra) & set(rb) if ra[k] != rb[k])
    for k in changed:
        if k not in allowed_changed:
            bad(f"resource {k} ({rb[k].get('Type')}) CHANGED and is not on the allow-list")
    for k in allowed_changed - set(changed):
        bad(f"resource {k} was expected to change but is identical (production is not in the baseline state)")
    for k, t in (("Handler886CB40B", None), ("IdentityHandler6F0A3417", (LIVE_ID_DESC, NEW_ID_DESC))):
        if k in changed:
            check_lambda(k, ra[k], rb[k], LIVE_HANDLER_KEY if k.startswith("Handler") else LIVE_IDENTITY_KEY, NEW_HANDLER_KEY if k.startswith("Handler") else NEW_IDENTITY_KEY, t)
    if "IdentityRole07BDF020" in changed:
        check_role("IdentityRole07BDF020", ra["IdentityRole07BDF020"], rb["IdentityRole07BDF020"])
    if "HandlerPolicy7544C855" in changed:
        check_policy("HandlerPolicy7544C855", ra["HandlerPolicy7544C855"], rb["HandlerPolicy7544C855"], ADDED_STATEMENT_HANDLER)
    if "IdentityPolicyF3EE534F" in changed:
        check_policy("IdentityPolicyF3EE534F", ra["IdentityPolicyF3EE534F"], rb["IdentityPolicyF3EE534F"], ADDED_STATEMENT_IDENTITY)
    print(f"resources: live {len(ra)}, release {len(rb)}; added {len(added)} ({len(routes)} routes, {len(others)} other); removed {len(removed)}; changed {len(changed)} ({', '.join(changed)})")
    if public_added:
        print(f"public (NONE) routes added: {public_added}")
    if V:
        for v in V:
            print("VIOLATION " + v)
        print("EXPECTED-ONLY: NO")
        return 1
    print("ALLOWED the release's code assets, descriptions, 2 added IAM statements, the ComplianceSweep rule and permission, and %d JWT-authorized routes" % len(routes))
    print("EXPECTED-ONLY: YES")
    return 0

if __name__ == "__main__":
    sys.exit(main())
