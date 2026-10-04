#!/usr/bin/env python3
"""Proves the release 0022-0026 scope gate is not vacuous, on the real templates.

The gate must PASS on the untampered build and FAIL on each tampered copy
(one change each). Read-only: works on copies in a temporary directory.
"""
import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
API = "Ogevia-prod-ServiceVerificationApi"
EGRESS = "Ogevia-prod-NetworkEgress"


def lid_of(t, prefix):
    return next(k for k in t["Resources"] if k.startswith(prefix))


def res(t, prefix):
    return t["Resources"][lid_of(t, prefix)]


def route(t, key):
    return next(r for r in t["Resources"].values() if r["Type"] == "AWS::ApiGatewayV2::Route" and r["Properties"]["RouteKey"] == key)


def stmts(t, prefix):
    return res(t, prefix)["Properties"]["PolicyDocument"]["Statement"]


def cognito_stmt(t):
    return next(s for s in stmts(t, "IdentityPolicy") if s["Sid"] == "CreateCaregiverSignIns")


API_MUTATIONS = {
    "identity_set_password_action": lambda t: cognito_stmt(t)["Action"].append("cognito-idp:AdminSetUserPassword"),
    "identity_add_to_group_action": lambda t: cognito_stmt(t)["Action"].append("cognito-idp:AdminAddUserToGroup"),
    "identity_any_pool": lambda t: cognito_stmt(t).__setitem__("Resource", "arn:aws:cognito-idp:us-west-2:300094796789:userpool/*"),
    "identity_secret_access": lambda t: stmts(t, "IdentityPolicy").append({"Action": "secretsmanager:GetSecretValue", "Effect": "Allow", "Resource": "*", "Sid": "X"}),
    "identity_extra_env": lambda t: res(t, "IdentityHandler")["Properties"]["Environment"]["Variables"].__setitem__("DB_HOST", "x"),
    "identity_other_name": lambda t: res(t, "IdentityHandler")["Properties"].__setitem__("FunctionName", "Ogevia-prod-Other"),
    "identity_role_trust_any": lambda t: res(t, "IdentityRole")["Properties"]["AssumeRolePolicyDocument"]["Statement"][0].__setitem__("Principal", {"AWS": "*"}),
    "identity_managed_admin": lambda t: res(t, "IdentityRole")["Properties"].__setitem__("ManagedPolicyArns", ["arn:aws:iam::aws:policy/AdministratorAccess"]),
    "identity_log_retention_forever": lambda t: res(t, "IdentityLogGroup")["Properties"].pop("RetentionInDays"),
    "handler_invoke_any_function": lambda t: next(s for s in stmts(t, "HandlerPolicy") if s["Sid"] == "InvokeIdentityAdmin").__setitem__("Resource", "*"),
    "handler_extra_statement": lambda t: stmts(t, "HandlerPolicy").append({"Action": "cognito-idp:AdminCreateUser", "Effect": "Allow", "Resource": "*", "Sid": "Y"}),
    "handler_existing_statement": lambda t: next(s for s in stmts(t, "HandlerPolicy") if s["Sid"] == "SignatureObjects")["Action"].append("s3:DeleteObject"),
    "handler_other_env": lambda t: res(t, "Handler8")["Properties"]["Environment"]["Variables"].__setitem__("DB_NAME", "postgres"),
    "handler_memory": lambda t: res(t, "Handler8")["Properties"].__setitem__("MemorySize", 2048),
    "route_public": lambda t: (route(t, "POST /v1/caregivers/{caregiverRecordId}/invitation")["Properties"].__setitem__("AuthorizationType", "NONE"),
                               route(t, "POST /v1/caregivers/{caregiverRecordId}/invitation")["Properties"].pop("AuthorizerId", None)),
    "route_missing": lambda t: t["Resources"].pop(next(k for k, r in t["Resources"].items() if r["Type"] == "AWS::ApiGatewayV2::Route" and r["Properties"]["RouteKey"] == "GET /v1/assignments")),
    "route_extra": lambda t: t["Resources"].__setitem__("ApiDELETEv1caregivers0000ABCD", dict(copy.deepcopy(route(t, "GET /v1/caregivers")), Properties=dict(route(t, "GET /v1/caregivers")["Properties"], RouteKey="DELETE /v1/caregivers"))),
    "output_added": lambda t: t.setdefault("Outputs", {}).__setitem__("Extra", {"Value": "x"}),
}

EGRESS_MUTATIONS = {
    "lambda_endpoint_any_function": lambda t: stmts(t, "LambdaEndpoint")[0].__setitem__("Resource", "*"),
    "lambda_endpoint_two_azs": lambda t: res(t, "LambdaEndpoint")["Properties"]["SubnetIds"].append("subnet-0000000000000000"),
    "lambda_endpoint_no_private_dns": lambda t: res(t, "LambdaEndpoint")["Properties"].__setitem__("PrivateDnsEnabled", False),
    "s3_endpoint_whole_bucket": lambda t: stmts(t, "S3GatewayEndpoint")[0].__setitem__("Resource", "arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*"),
    "s3_endpoint_delete": lambda t: stmts(t, "S3GatewayEndpoint")[0]["Action"].append("s3:DeleteObject"),
    "egress_nat_gateway": lambda t: t["Resources"].__setitem__("Nat00000000", {"Type": "AWS::EC2::NatGateway", "Properties": {"SubnetId": "s"}}),
}


def other_stack(cdk):
    p = os.path.join(cdk, "Ogevia-prod-EvidenceStorage.template.json")
    t = json.load(open(p))
    for r in t["Resources"].values():
        if r["Type"] == "AWS::S3::Bucket":
            r["Properties"]["VersioningConfiguration"] = {"Status": "Suspended"}
    json.dump(t, open(p, "w"))


def gate(cdk, deployed):
    return subprocess.run([sys.executable, os.path.join(HERE, "release_0026_gate.py"), "--cdk-out", cdk, "--deployed", deployed],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1")).returncode


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--cdk-out", required=True)
    a.add_argument("--deployed", required=True)
    args = a.parse_args()
    ok = True
    rc = gate(args.cdk_out, args.deployed)
    print("%s gate passes the untampered build" % ("PASS" if rc == 0 else "FAIL"))
    ok &= rc == 0
    cases = [(n, f, API) for n, f in API_MUTATIONS.items()] + [(n, f, EGRESS) for n, f in EGRESS_MUTATIONS.items()] + [("other_stack_change", None, None)]
    with tempfile.TemporaryDirectory() as tmp:
        for name, fn, stack in cases:
            cdk = os.path.join(tmp, name)
            os.mkdir(cdk)
            for f in os.listdir(args.cdk_out):
                if f.endswith(".template.json"):
                    shutil.copy(os.path.join(args.cdk_out, f), cdk)
            if stack:
                p = os.path.join(cdk, stack + ".template.json")
                t = json.load(open(p))
                fn(t)
                json.dump(t, open(p, "w"))
            else:
                other_stack(cdk)
            rc = gate(cdk, args.deployed)
            print("%s gate refuses: %s" % ("PASS" if rc == 1 else "FAIL", name))
            ok &= rc == 1
    print("Gate self-test: %s (%d tampered variants)" % ("PASS" if ok else "FAIL", len(cases)))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
