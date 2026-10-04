#!/usr/bin/env python3
"""Read-only live checks for release 0022-0025 (standard library only).

Each sub-command reads files captured by release-0025-deploy.sh and prints
"ok" or "no". It never calls AWS itself.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from release_0025_gate import ACCOUNT, IDENTITY_NAME, NEW_ROUTES, POOL, REGION, S3_RESOURCES  # noqa: E402


def as_list(v):
    return v if isinstance(v, list) else [v]


def norm(s):
    return json.dumps({k: (sorted(v) if isinstance(v, list) else v) for k, v in s.items()}, sort_keys=True)


def routes(before_path, after_path):
    before = dict(map(tuple, json.load(open(before_path))))
    after = dict(map(tuple, json.load(open(after_path))))
    return (len(after) == len(before) + len(NEW_ROUTES) and all(after.get(k) == a for k, a in before.items())
            and all(after.get(k) == "JWT" for k in NEW_ROUTES))


def handler_policy(before_path, after_path, identity_arn):
    b = [norm(s) for s in json.load(open(before_path))["Statement"]]
    a = [norm(s) for s in json.load(open(after_path))["Statement"]]
    want = norm({"Sid": "InvokeIdentityAdmin", "Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": identity_arn})
    return identity_arn.endswith(":function:" + IDENTITY_NAME) and sorted(a) == sorted(b + [want])


def identity(fn_path, policy_path):
    fn = json.load(open(fn_path))
    doc = json.load(open(policy_path))
    actions = sorted(a for s in doc["Statement"] for a in as_list(s["Action"]))
    cognito = [s for s in doc["Statement"] if any(str(a).startswith("cognito-idp:") for a in as_list(s["Action"]))]
    return (not (fn.get("VpcConfig") or {}).get("SubnetIds")
            and sorted((fn.get("Environment") or {}).get("Variables", {})) == ["COGNITO_USER_POOL_ID"]
            and actions == ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "logs:CreateLogStream", "logs:PutLogEvents"]
            and len(cognito) == 1 and cognito[0]["Resource"] == "arn:aws:cognito-idp:%s:%s:userpool/%s" % (REGION, ACCOUNT, POOL))


def endpoints(lambda_path, s3_path):
    ep = json.load(open(lambda_path))["VpcEndpoints"]
    s3 = json.load(open(s3_path))["VpcEndpoints"]
    if len(ep) != 1 or ep[0]["State"].lower() != "available" or not ep[0]["PrivateDnsEnabled"] or len(ep[0]["SubnetIds"]) != 1:
        return False
    st = json.loads(ep[0]["PolicyDocument"])["Statement"]
    if len(st) != 1 or st[0]["Action"] != "lambda:InvokeFunction" or \
            st[0]["Resource"] != "arn:aws:lambda:%s:%s:function:%s" % (REGION, ACCOUNT, IDENTITY_NAME):
        return False
    if len(s3) != 1:
        return False
    res = json.loads(s3[0]["PolicyDocument"])["Statement"][0]["Resource"]
    return sorted(as_list(res)) == S3_RESOURCES


CHECKS = {"routes": routes, "handler-policy": handler_policy, "identity": identity, "endpoints": endpoints}

if __name__ == "__main__":
    try:
        print("ok" if CHECKS[sys.argv[1]](*sys.argv[2:]) else "no")
    except Exception:  # a missing or malformed capture is a failed check, never a crash
        print("no")
