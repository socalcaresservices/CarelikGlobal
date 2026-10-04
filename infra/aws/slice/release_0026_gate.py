#!/usr/bin/env python3
"""Deployment scope gate for release 0022-0026 (standard library only). STRICT.

Compares each synthesized template (cdk.out) with the template CloudFormation
has deployed (captured just before the change; base = the 1a39dd5 increment)
and FAILS unless the difference is exactly this release:

ServiceVerificationApi
  1. ADD the 30 routes in NEW_ROUTES, each identical to the live GET /v1/me
     route except its RouteKey (JWT, the one existing integration), plus one
     route-scoped invoke permission each (checked by increment_diff_gate).
  2. MODIFY the existing Handler: code package, and exactly one new
     environment variable IDENTITY_FUNCTION_NAME = Ogevia-prod-IdentityAdmin.
  3. MODIFY HandlerPolicy: exactly the InvokeIdentityAdmin statement added
     (lambda:InvokeFunction on the new identity function only).
  4. ADD the identity function and only its role, policy and log group, each
     exactly as in EXPECTED_IDENTITY: outside the VPC, pool id the only
     setting, AdminCreateUser + AdminGetUser on the one pool, own log group.
NetworkEgress
  5. ADD the Lambda interface endpoint: 1 subnet, private DNS, the existing
     endpoint security group, policy = invoke Ogevia-prod-IdentityAdmin only.
  6. MODIFY the S3 gateway endpoint policy Resource only: the signature key
     shape plus the staff-document and logo key shapes (no other change).
Everything else, in every stack, identical; nothing removed; public routes
exactly the approved list. Exit 1 = stop.
"""
import argparse
import copy
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import increment_diff_gate as base  # noqa: E402
from pilot_diff_gate import STACKS, API_STACK, diff_paths, handler_id, public_route_keys, without  # noqa: E402
from smoke import APPROVED_PUBLIC_ROUTE_KEYS  # noqa: E402

ACCOUNT, REGION, POOL = "300094796789", "us-west-2", "us-west-2_849AYz5J7"
EGRESS_STACK = "Ogevia-prod-NetworkEgress"
IDENTITY_NAME = "Ogevia-prod-IdentityAdmin"
BUCKET_ARN = base.BUCKET_ARN
NEW_ROUTES = sorted([
    "GET /v1/assignments",
    "GET /v1/caregivers",
    "GET /v1/client-types",
    "GET /v1/clients",
    "GET /v1/clients/{clientId}/authorizations",
    "GET /v1/services",
    "POST /v1/assignments",
    "POST /v1/assignments/{assignmentId}/end",
    "POST /v1/authorizations/{authorizationId}/amend",
    "POST /v1/caregivers",
    "POST /v1/caregivers/{caregiverRecordId}/details",
    "POST /v1/caregivers/{caregiverRecordId}/invitation",
    "POST /v1/caregivers/{caregiverRecordId}/invitation/resend",
    "POST /v1/caregivers/{caregiverRecordId}/status",
    "POST /v1/client-types",
    "POST /v1/clients",
    "POST /v1/clients/{clientId}/authorizations",
    "POST /v1/clients/{clientId}/details",
    "POST /v1/clients/{clientId}/status",
    "POST /v1/services",
    "POST /v1/services/{serviceId}/name",
    "POST /v1/services/{serviceId}/status",
    "GET /v1/shifts",
    "POST /v1/shifts",
    "POST /v1/shifts/{shiftId}/callout",
    "POST /v1/shifts/{shiftId}/caregiver",
    "POST /v1/shifts/{shiftId}/cancel",
    "GET /v1/shifts/{shiftId}/coverage",
    "GET /v1/my-shifts",
    "POST /v1/my-shifts/{shiftId}/callout",
])
INVOKE_STATEMENT_SID = "InvokeIdentityAdmin"
S3_RESOURCES = sorted(BUCKET_ARN + p for p in ["/*/*/client-signature.png", "/*/documents/*/*", "/*/branding/logo/*"])
TAGS = "__LIVE_TAGS__"


def expected_identity(lids):
    """The four added resources, exactly. lids maps role name -> logical id in the build."""
    return {
        "IdentityRole": {"Type": "AWS::IAM::Role", "Properties": {
            "AssumeRolePolicyDocument": {"Statement": [{"Action": "sts:AssumeRole", "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}}], "Version": "2012-10-17"},
            "Description": "Ogevia caregiver invitation identity function (Cognito create/resend only)", "Tags": TAGS}},
        "IdentityLogGroup": {"Type": "AWS::Logs::LogGroup", "Properties": {"RetentionInDays": 365, "Tags": TAGS},
                             "UpdateReplacePolicy": "Retain", "DeletionPolicy": "Retain"},
        "IdentityPolicy": {"Type": "AWS::IAM::ManagedPolicy", "Properties": {
            "Description": "Ogevia identity function: own logs + AdminCreateUser/AdminGetUser on the one user pool", "Path": "/",
            "PolicyDocument": {"Statement": [
                {"Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Effect": "Allow", "Resource": {"Fn::GetAtt": [lids["IdentityLogGroup"], "Arn"]}, "Sid": "WriteOwnLogGroup"},
                {"Action": ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"], "Effect": "Allow",
                 "Resource": "arn:aws:cognito-idp:%s:%s:userpool/%s" % (REGION, ACCOUNT, POOL), "Sid": "CreateCaregiverSignIns"}],
                "Version": "2012-10-17"},
            "Roles": [{"Ref": lids["IdentityRole"]}]}},
        "IdentityHandler": {"Type": "AWS::Lambda::Function", "Properties": {
            "Architectures": ["arm64"], "Code": {"S3Bucket": "cdk-hnb659fds-assets-%s-%s" % (ACCOUNT, REGION), "S3Key": "__ASSET__"},
            "Description": "Ogevia caregiver invitations: Cognito AdminCreateUser/AdminGetUser only",
            "Environment": {"Variables": {"COGNITO_USER_POOL_ID": POOL}}, "FunctionName": IDENTITY_NAME, "Handler": "index.handler",
            "LoggingConfig": {"LogGroup": {"Ref": lids["IdentityLogGroup"]}}, "MemorySize": 256,
            "Role": {"Fn::GetAtt": [lids["IdentityRole"], "Arn"]}, "Runtime": "nodejs24.x", "Tags": TAGS, "Timeout": 8},
            "DependsOn": sorted([lids["IdentityPolicy"], lids["IdentityRole"]])},
    }


def expected_lambda_endpoint(sg_ref, subnet_ids):
    return {"Type": "AWS::EC2::VPCEndpoint", "Properties": {
        "PolicyDocument": {"Statement": [{"Action": "lambda:InvokeFunction", "Condition": {"StringEquals": {"aws:PrincipalAccount": ACCOUNT}},
                                          "Effect": "Allow", "Principal": {"AWS": "*"},
                                          "Resource": "arn:aws:lambda:%s:%s:function:%s" % (REGION, ACCOUNT, IDENTITY_NAME)}], "Version": "2012-10-17"},
        "PrivateDnsEnabled": True, "SecurityGroupIds": sg_ref, "ServiceName": "com.amazonaws.%s.lambda" % REGION,
        "SubnetIds": subnet_ids, "Tags": TAGS, "VpcEndpointType": "Interface", "VpcId": "vpc-0ee9df0c38297cbc1"}}


def live_tags(old):
    for r in old.values():
        tags = r.get("Properties", {}).get("Tags")
        if isinstance(tags, list) and any(isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status" for t in tags):
            return tags
    return None


def fill(want, tags):
    return json.loads(json.dumps(want).replace('"%s"' % TAGS, json.dumps(tags)))


def check_identity_additions(stack, old, new, added, failures, lines):
    """Returns the logical ids of the identity resources that were verified."""
    by_prefix = {}
    for lid in added:
        for name in ("IdentityHandler", "IdentityLogGroup", "IdentityPolicy", "IdentityRole"):
            if re.fullmatch(name + "[0-9A-F]{8}", lid):
                by_prefix.setdefault(name, []).append(lid)
    if sorted(by_prefix) != ["IdentityHandler", "IdentityLogGroup", "IdentityPolicy", "IdentityRole"] or any(len(v) != 1 for v in by_prefix.values()):
        failures.append("%s: expected exactly one each of IdentityHandler/LogGroup/Policy/Role, found %s" % (stack, by_prefix))
        return set()
    lids = {k: v[0] for k, v in by_prefix.items()}
    tags = live_tags(old)
    for name, want in expected_identity(lids).items():
        lid = lids[name]
        got = copy.deepcopy(new[lid])
        meta = got.pop("Metadata", {}) or {}
        if name == "IdentityHandler":
            key = got.get("Properties", {}).get("Code", {}).get("S3Key", "")
            if not re.fullmatch(r"[0-9a-f]{64}\.zip", key):
                failures.append("%s: %s code package is not a bundled asset" % (stack, lid))
            got["Properties"]["Code"]["S3Key"] = "__ASSET__"
            if "DependsOn" in got:
                got["DependsOn"] = sorted(got["DependsOn"])
            extra_meta = set(meta) - {"aws:cdk:path", "aws:asset:path", "aws:asset:is-bundled", "aws:asset:property"}
        else:
            extra_meta = set(meta) - {"aws:cdk:path"}
        bad = diff_paths(fill(want, tags), got)
        if bad or extra_meta:
            failures.append("%s: %s (%s) differs from the approved definition: %s" % (stack, lid, name, ", ".join(bad + sorted(extra_meta))))
        else:
            lines.append("%s: + %s (%s) exactly as approved" % (stack, lid, new[lid]["Type"]))
    return set(lids.values())


def check_handler(old_r, new_r):
    paths = ("Properties.Code.S3Key", "Metadata.aws:asset:path", "Properties.Environment.Variables.IDENTITY_FUNCTION_NAME")
    bad = diff_paths(without(old_r, *paths), without(new_r, *paths))
    if "IDENTITY_FUNCTION_NAME" in old_r.get("Properties", {}).get("Environment", {}).get("Variables", {}):
        bad.append("IDENTITY_FUNCTION_NAME already set live")
    if new_r.get("Properties", {}).get("Environment", {}).get("Variables", {}).get("IDENTITY_FUNCTION_NAME") != IDENTITY_NAME:
        bad.append("IDENTITY_FUNCTION_NAME is not %s" % IDENTITY_NAME)
    return bad


def check_policy(old_r, new_r, identity_lid):
    bad = diff_paths(without(old_r, base.POLICY_PATH), without(new_r, base.POLICY_PATH))
    if bad:
        return bad
    want = {"Action": "lambda:InvokeFunction", "Effect": "Allow", "Resource": {"Fn::GetAtt": [identity_lid, "Arn"]}, "Sid": INVOKE_STATEMENT_SID}
    old_s = old_r["Properties"]["PolicyDocument"]["Statement"]
    new_s = new_r["Properties"]["PolicyDocument"]["Statement"]
    added = [s for s in new_s if s not in old_s]
    kept = [s for s in new_s if s in old_s]
    if kept != old_s:
        return ["existing statements changed, removed or reordered"]
    if added != [want]:
        return ["the added statements are not exactly %s on the identity function" % INVOKE_STATEMENT_SID]
    return []


def check_s3_endpoint(old_r, new_r):
    path = "Properties.PolicyDocument.Statement"
    bad = diff_paths(without(old_r, path), without(new_r, path))
    os_, ns = old_r["Properties"]["PolicyDocument"]["Statement"], new_r["Properties"]["PolicyDocument"]["Statement"]
    if len(os_) != 1 or len(ns) != 1:
        return bad + ["expected one endpoint policy statement"]
    bad += diff_paths(without(os_[0], "Resource"), without(ns[0], "Resource"))
    res = ns[0].get("Resource")
    if sorted(res if isinstance(res, list) else [res]) != S3_RESOURCES:
        bad.append("endpoint Resource is not exactly the three object key shapes")
    return bad


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cdk-out", required=True)
    p.add_argument("--deployed", required=True)
    p.add_argument("--summary")
    args = p.parse_args()
    lines, failures = [], []
    base.NEW_ROUTES = NEW_ROUTES

    for stack in STACKS:
        new_t = json.load(open(os.path.join(args.cdk_out, stack + ".template.json")))
        path = os.path.join(args.deployed, stack + ".json")
        if not os.path.exists(path):
            failures.append("%s: not deployed (this workflow never creates stacks)" % stack)
            continue
        old_t = json.load(open(path))
        for s in diff_paths({k: v for k, v in old_t.items() if k != "Resources"},
                            {k: v for k, v in new_t.items() if k != "Resources"}):
            failures.append("%s: template section differs: %s" % (stack, s))
        old, new = old_t.get("Resources", {}), new_t.get("Resources", {})
        added = sorted(set(new) - set(old))
        removed = sorted(set(old) - set(new))
        modified = sorted(lid for lid in set(old) & set(new) if old[lid] != new[lid])
        if not (added or removed or modified):
            lines.append("%s: no changes" % stack)
            continue
        for lid in removed:
            failures.append("%s: would REMOVE %s (%s)" % (stack, lid, old[lid]["Type"]))
        identity_lids, identity_handler = set(), None
        if stack == API_STACK:
            identity_lids = check_identity_additions(stack, old, new, added, failures, lines)
            identity_handler = next((lid for lid in identity_lids if lid.startswith("IdentityHandler")), None)
            base.check_additions(old, new, [lid for lid in added if lid not in identity_lids], failures, lines)
        elif stack == EGRESS_STACK:
            endpoint_sg = [lid for lid, r in old.items() if r.get("Type") == "AWS::EC2::SecurityGroup"]
            secrets = [r for r in old.values() if r.get("Type") == "AWS::EC2::VPCEndpoint" and r["Properties"].get("VpcEndpointType") == "Interface"]
            ok_ids = set()
            for lid in added:
                if re.fullmatch(r"LambdaEndpoint[0-9A-F]{8}", lid) and len(endpoint_sg) == 1 and len(secrets) == 1:
                    want = fill(expected_lambda_endpoint([{"Fn::GetAtt": [endpoint_sg[0], "GroupId"]}], secrets[0]["Properties"]["SubnetIds"]), live_tags(old))
                    got = without(new[lid], "Metadata")
                    bad = diff_paths(want, got) + sorted(set(new[lid].get("Metadata") or {}) - {"aws:cdk:path"})
                    if bad:
                        failures.append("%s: %s differs from the approved Lambda endpoint: %s" % (stack, lid, ", ".join(bad)))
                    else:
                        lines.append("%s: + %s Lambda interface endpoint (1 AZ, private DNS, existing endpoint SG; invoke %s only)" % (stack, lid, IDENTITY_NAME))
                    ok_ids.add(lid)
            for lid in added:
                if lid not in ok_ids:
                    failures.append("%s: would ADD %s (%s)" % (stack, lid, new[lid]["Type"]))
        else:
            for lid in added:
                failures.append("%s: would ADD %s (%s)" % (stack, lid, new[lid]["Type"]))
        h = handler_id(old) if stack == API_STACK else None
        for lid in modified:
            t = new[lid]["Type"]
            if t != old[lid].get("Type"):
                bad = ["Type"]
            elif t == "AWS::CDK::Metadata":
                bad = diff_paths(without(old[lid], "Properties.Analytics"), without(new[lid], "Properties.Analytics"))
                if not bad:
                    lines.append("%s: ~ CDK metadata Analytics only (creates nothing in AWS)" % stack)
                    continue
            elif lid == h:
                bad = check_handler(old[lid], new[lid])
                if not bad:
                    lines.append("%s: ~ %s (the existing Handler) code package + IDENTITY_FUNCTION_NAME=%s" % (stack, lid, IDENTITY_NAME))
                    continue
            elif stack == API_STACK and t == "AWS::IAM::ManagedPolicy" and lid.startswith("HandlerPolicy") and identity_handler:
                bad = check_policy(old[lid], new[lid], identity_handler)
                if not bad:
                    lines.append("%s: ~ %s + statement %s: lambda:InvokeFunction on %s only" % (stack, lid, INVOKE_STATEMENT_SID, identity_handler))
                    continue
            elif stack == EGRESS_STACK and t == "AWS::EC2::VPCEndpoint" and lid.startswith("S3GatewayEndpoint"):
                bad = check_s3_endpoint(old[lid], new[lid])
                if not bad:
                    lines.append("%s: ~ %s policy Resource: signatures + staff documents + agency logo key shapes" % (stack, lid))
                    continue
            else:
                bad = diff_paths(old[lid], new[lid])
            failures.append("%s: would MODIFY %s (%s): %s" % (stack, lid, t, ", ".join(bad)))

    api_new = json.load(open(os.path.join(args.cdk_out, API_STACK + ".template.json")))
    pub = public_route_keys(api_new)
    if pub == APPROVED_PUBLIC_ROUTE_KEYS:
        lines.append("Public (no sign-in) API routes: %d, exactly the approved list (none added)" % len(pub))
    else:
        failures.append("Public API routes differ from the approved list: extra %s, missing %s" % (
            sorted(set(pub) - set(APPROVED_PUBLIC_ROUTE_KEYS)), sorted(set(APPROVED_PUBLIC_ROUTE_KEYS) - set(pub))))

    out = ["Deployment scope gate, release 0022-0026 (strict)"] + ["  " + line for line in lines]
    out += (["STOP - outside the approved change:"] + ["  " + f for f in failures]) if failures else ["Scope gate: PASS"]
    text = "\n".join(out)
    print(text)
    if args.summary:
        with open(args.summary, "w") as f:
            f.write(text + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
