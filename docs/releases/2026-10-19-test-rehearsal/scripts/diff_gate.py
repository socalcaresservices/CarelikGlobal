#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the two stack deployments of the TEST rehearsal (release 0b593e5). Read-only: it compares two CloudFormation templates (or two endpoint
policies) as JSON files and prints every difference. Exit 0 only if EVERY difference is on the allow-list below; anything else exits 1 and the operator STOPS.

  python3 diff_gate.py template --stack Ogevia-prod-NetworkEgress|Ogevia-prod-ServiceVerificationApi --live LIVE.json --new NEW.json
      LIVE.json = `aws cloudformation get-template --stack-name S --template-stage Original --query TemplateBody --output json`; NEW.json = the synthesized template.
  python3 diff_gate.py endpoint-policy --before BEFORE.json --after AFTER.json
      BEFORE/AFTER = the S3 gateway endpoint's PolicyDocument as captured from `aws ec2 describe-vpc-endpoints` before and after the NetworkEgress deployment.
      The change must be ADDITIVE ONLY: every earlier statement, resource, principal, action and condition survives unchanged, for the TEST bucket AND the production
      bucket, and the only additions are the client-documents key pattern for those two buckets.

ALLOW-LIST (everything else is a violation):
  Both stacks: no resource added, removed or replaced; Description, Parameters, Outputs, Conditions, Mappings, Rules and Transform equal; CDK::Metadata ignored; the VALUE of
  the `ogevia:deployment-status` tag ignored (it carries the approval reference).
  Ogevia-prod-NetworkEgress: only the S3 gateway endpoint changes, and only inside Properties.PolicyDocument.Statement[*].Resource: the two client-documents ARNs
      arn:aws:s3:::<bucket>/*/client-documents/*/*  for the TEST bucket (ogevia-prod-...) and the production bucket (ogevia-prd-...) are ADDED; nothing is removed or altered.
  Ogevia-prod-ServiceVerificationApi: only (1) the API Handler's Code S3Key (and the asset path in its Metadata) and (2) the Handler's managed policy, which gains exactly
      one statement, Sid ClientDocumentObjects: Allow s3:GetObject, s3:GetObjectVersion, s3:PutObject on the TEST bucket's */client-documents/*/* only. Nothing else (no Lambda
      environment, role, route, permission, rule, Cognito, RDS, security-group, KMS or bucket-policy change).
"""
import argparse, copy, json, sys

ACCOUNT = "300094796789"
REGION = "us-west-2"
TEST_BUCKET = "ogevia-prod-signature-evidence-%s-%s" % (ACCOUNT, REGION)
PRD_BUCKET = "ogevia-prd-signature-evidence-%s-%s" % (ACCOUNT, REGION)
CD = "*/client-documents/*/*"
ADDED_ENDPOINT_RESOURCES = {"arn:aws:s3:::%s/%s" % (TEST_BUCKET, CD), "arn:aws:s3:::%s/%s" % (PRD_BUCKET, CD)}
NET = "Ogevia-prod-NetworkEgress"
API = "Ogevia-prod-ServiceVerificationApi"
SECTIONS = ["Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform", "AWSTemplateFormatVersion"]
HEX64 = set("0123456789abcdef")


def norm_tags(x):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out[k] = "<APPROVAL>" if k == "ogevia:deployment-status" else norm_tags(v)
        return out
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


def as_list(v):
    return v if isinstance(v, list) else [v]


def rset(v):
    """The set of resource entries, hashable (CloudFormation intrinsics such as Fn::Join are dicts)."""
    return set(x if isinstance(x, str) else json.dumps(x, sort_keys=True) for x in as_list(v))


def stmt_key(s):
    """Everything about a statement EXCEPT its resources (and Sid-less ordering)."""
    k = {kk: vv for kk, vv in s.items() if kk != "Resource"}
    for f in ("Action", "NotAction"):
        if f in k:
            k[f] = sorted(as_list(k[f]))
    return json.dumps(k, sort_keys=True)


def statements(doc):
    st = doc.get("Statement", [])
    return as_list(st)


def compare_statements(live, new, v, where, allow_added_resources=None, allow_added_statement=None):
    """Additive-only comparison of two policy documents. Returns nothing; appends violations to v."""
    if {k: x for k, x in live.items() if k != "Statement"} != {k: x for k, x in new.items() if k != "Statement"}:
        v.append("%s: the policy document changed outside Statement" % where)
    L, N = statements(live), statements(new)
    nbykey = {}
    for s in N:
        nbykey.setdefault(stmt_key(s), []).append(s)
    matched = set()
    for s in L:
        cands = nbykey.get(stmt_key(s), [])
        hit = None
        for i, c in enumerate(cands):
            if id(c) in matched:
                continue
            if rset(s.get("Resource", [])) <= rset(c.get("Resource", [])):
                hit = c
                break
        if hit is None:
            v.append("%s: an existing statement was removed or altered: %s" % (where, json.dumps(s, sort_keys=True)[:300]))
            continue
        matched.add(id(hit))
        added = rset(hit.get("Resource", [])) - rset(s.get("Resource", []))
        if added:
            if allow_added_resources is None or added != allow_added_resources:
                v.append("%s: unexpected resources added to an existing statement: %s" % (where, sorted(added)))
    extra = [s for s in N if id(s) not in matched]
    for s in extra:
        if allow_added_statement is not None and s == allow_added_statement:
            continue
        v.append("%s: an unexpected statement was added: %s" % (where, json.dumps(s, sort_keys=True)[:300]))
    if allow_added_statement is not None and allow_added_statement not in extra:
        v.append("%s: the expected new statement %s is not present" % (where, allow_added_statement.get("Sid")))
    return


def blank(obj, path):
    """Replace obj at a dotted path (dict keys only) with a marker, in place; ignore if absent."""
    cur = obj
    parts = path.split(".")
    for p in parts[:-1]:
        if not isinstance(cur, dict) or p not in cur:
            return
        cur = cur[p]
    if isinstance(cur, dict) and parts[-1] in cur:
        cur[parts[-1]] = "<ALLOWED>"


def gate_template(stack, live, new):
    v, ok_notes = [], []
    if stack not in (NET, API):
        return ["no allow-list exists for stack '%s': only %s and %s may be deployed by this procedure" % (stack, NET, API)], []
    live, new = norm_tags(live), norm_tags(new)
    for sec in SECTIONS:
        if live.get(sec) != new.get(sec):
            v.append("template section %s differs" % sec)
    lr = {k: x for k, x in live["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: x for k, x in new["Resources"].items() if x.get("Type") != "AWS::CDK::Metadata"}
    for k in sorted(set(nr) - set(lr)):
        v.append("resource ADDED: %s (%s)" % (k, nr[k].get("Type")))
    for k in sorted(set(lr) - set(nr)):
        v.append("resource REMOVED: %s (%s)" % (k, lr[k].get("Type")))
    for k in sorted(set(lr) & set(nr)):
        a, b = lr[k], nr[k]
        if a == b:
            continue
        if a.get("Type") != b.get("Type"):
            v.append("resource %s changes TYPE (replacement): %s -> %s" % (k, a.get("Type"), b.get("Type")))
            continue
        t = a.get("Type")
        if stack == NET and t == "AWS::EC2::VPCEndpoint" and a.get("Properties", {}).get("VpcEndpointType") == "Gateway" and "s3" in json.dumps(a["Properties"].get("ServiceName")):
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            blank(a2, "Properties.PolicyDocument"); blank(b2, "Properties.PolicyDocument")
            if a2 != b2:
                v.append("S3 gateway endpoint %s changed outside Properties.PolicyDocument" % k)
            before = [x for x in statements(a["Properties"]["PolicyDocument"])]
            vv = []
            compare_statements(a["Properties"]["PolicyDocument"], b["Properties"]["PolicyDocument"], vv, "S3 gateway endpoint policy", allow_added_resources=ADDED_ENDPOINT_RESOURCES)
            v.extend(vv)
            if not vv:
                # every statement that grew must have grown by BOTH client-documents ARNs (checked inside), and at least one must have grown
                grew = sum(1 for s in statements(b["Properties"]["PolicyDocument"]) if ADDED_ENDPOINT_RESOURCES <= rset(s.get("Resource", [])))
                if grew != 1:
                    v.append("S3 gateway endpoint policy: expected exactly one statement to gain the two client-documents resources, found %d" % grew)
                else:
                    ok_notes.append("S3 gateway endpoint policy gains %s (additive only; %d earlier resources unchanged)" % (", ".join(sorted(ADDED_ENDPOINT_RESOURCES)), sum(len(rset(s.get('Resource', []))) for s in before)))
            continue
        if stack == API and t == "AWS::Lambda::Function" and k.startswith("Handler") and not k.startswith("IdentityHandler"):
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            for x in (a2, b2):
                blank(x, "Properties.Code.S3Key"); blank(x, "Metadata.aws:asset:path")
            # "aws:asset:path" contains a dot-free key but the colon is fine; Metadata keys are plain dict keys
            if a2 != b2:
                v.append("Lambda %s changed beyond its code asset (S3Key / asset path)" % k)
            else:
                nk = b["Properties"]["Code"]["S3Key"]
                if not (isinstance(nk, str) and nk.endswith(".zip") and set(nk[:-4]) <= HEX64 and len(nk) == 68):
                    v.append("Lambda %s: the new code S3Key '%s' is not a CDK asset key" % (k, nk))
                elif nk == a["Properties"]["Code"]["S3Key"]:
                    v.append("Lambda %s: the code asset did not change (nothing to deploy?)" % k)
                else:
                    ok_notes.append("Lambda %s code asset %s... -> %s..." % (k, a["Properties"]["Code"]["S3Key"][:12], nk[:12]))
            continue
        if stack == API and t == "AWS::IAM::ManagedPolicy" and k.startswith("HandlerPolicy"):
            a2, b2 = copy.deepcopy(a), copy.deepcopy(b)
            blank(a2, "Properties.PolicyDocument"); blank(b2, "Properties.PolicyDocument")
            if a2 != b2:
                v.append("managed policy %s changed outside its PolicyDocument" % k)
            want = {"Sid": "ClientDocumentObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], "Resource": "arn:aws:s3:::%s/%s" % (TEST_BUCKET, CD)}
            def canon(s):
                s = copy.deepcopy(s)
                if "Action" in s: s["Action"] = sorted(as_list(s["Action"]))
                return s
            na = copy.deepcopy(b["Properties"]["PolicyDocument"]); nl = copy.deepcopy(a["Properties"]["PolicyDocument"])
            na["Statement"] = [canon(s) for s in statements(na)]; nl["Statement"] = [canon(s) for s in statements(nl)]
            vv = []
            compare_statements(nl, na, vv, "handler managed policy", allow_added_resources=None, allow_added_statement=want)
            v.extend(vv)
            if not vv:
                ok_notes.append("handler managed policy %s gains the single statement ClientDocumentObjects (Allow s3:GetObject/GetObjectVersion/PutObject on the TEST bucket */client-documents/*/* only)" % k)
            continue
        v.append("resource CHANGED outside the allow-list: %s (%s)" % (k, t))
    if not v:
        wanted = 1 if stack == NET else 2
        if len(ok_notes) != wanted:
            v.append("expected exactly %d allowed change(s) for %s, found %d: the template pair is not the release's difference" % (wanted, stack, len(ok_notes)))
    return v, ok_notes


def gate_endpoint(before, after):
    v = []
    if before.get("Version") != after.get("Version"):
        v.append("policy Version changed")
    b = {k: x for k, x in before.items() if k != "Statement"}; a = {k: x for k, x in after.items() if k != "Statement"}
    if a != b:
        v.append("policy document changed outside Statement")
    compare_statements(before, after, v, "endpoint policy", allow_added_resources=ADDED_ENDPOINT_RESOURCES)
    old_res = set(r for s in statements(before) for r in rset(s.get("Resource", [])))
    new_res = set(r for s in statements(after) for r in rset(s.get("Resource", [])))
    if old_res - new_res:
        v.append("endpoint policy LOST resources: %s" % sorted(old_res - new_res))
    for bucket, label in ((TEST_BUCKET, "TEST"), (PRD_BUCKET, "PRODUCTION")):
        lost = [r for r in old_res if bucket in r and r not in new_res]
        if lost:
            v.append("the %s bucket lost access: %s" % (label, sorted(lost)))
    if not v and (new_res - old_res) != ADDED_ENDPOINT_RESOURCES:
        v.append("the endpoint policy did not gain exactly the two client-documents resources (gained: %s)" % sorted(new_res - old_res))
    return v


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    t = sub.add_parser("template"); t.add_argument("--stack", required=True); t.add_argument("--live", required=True); t.add_argument("--new", required=True)
    e = sub.add_parser("endpoint-policy"); e.add_argument("--before", required=True); e.add_argument("--after", required=True)
    a = ap.parse_args(argv)
    try:
        if a.mode == "template":
            v, notes = gate_template(a.stack, load(a.live), load(a.new))
            for n in notes:
                print("ALLOWED " + n)
            for x in v:
                print("VIOLATION " + x)
            print("EXPECTED-ONLY: YES" if not v else "EXPECTED-ONLY: NO (%d violation(s)). STOP." % len(v))
            return 0 if not v else 1
        def pol(path):
            with open(path) as fh:
                d = json.load(fh)
            if isinstance(d, str):
                d = json.loads(d)
            if not isinstance(d, dict) or "Statement" not in d:
                raise ValueError("%s is not an IAM policy document" % path)
            return d
        v = gate_endpoint(pol(a.before), pol(a.after))
        for x in v:
            print("VIOLATION " + x)
        print("ENDPOINT POLICY ADDITIVE-ONLY: YES" if not v else "ENDPOINT POLICY ADDITIVE-ONLY: NO (%d violation(s)). STOP." % len(v))
        return 0 if not v else 1
    except (OSError, ValueError, KeyError, TypeError) as ex:
        print("VIOLATION cannot evaluate the input (%s): treated as a failure" % ex)
        print("EXPECTED-ONLY: NO. STOP.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
