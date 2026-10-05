#!/usr/bin/env python3
"""Proves the release 0027-0034 scope gate is not vacuous, on the real templates.

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


def permission(t):
    return [r for r in t["Resources"].values() if r["Type"] == "AWS::Lambda::Permission"][0]


API_MUTATIONS = {
    "route_public": lambda t: (route(t, "GET /v1/visits/{visitId}/review")["Properties"].__setitem__("AuthorizationType", "NONE"),
                               route(t, "GET /v1/visits/{visitId}/review")["Properties"].pop("AuthorizerId", None)),
    "route_missing": lambda t: t["Resources"].pop(next(k for k, r in t["Resources"].items() if r["Type"] == "AWS::ApiGatewayV2::Route" and r["Properties"]["RouteKey"] == "POST /v1/shift-series")),
    "route_extra": lambda t: t["Resources"].__setitem__("ApiDELETEv1shiftseries0000ABCD", dict(copy.deepcopy(route(t, "GET /v1/shift-series")), Properties=dict(route(t, "GET /v1/shift-series")["Properties"], RouteKey="DELETE /v1/shift-series"))),
    "existing_route_removed": lambda t: t["Resources"].pop(next(k for k, r in t["Resources"].items() if r["Type"] == "AWS::ApiGatewayV2::Route" and r["Properties"]["RouteKey"] == "GET /v1/shifts")),
    "existing_route_public": lambda t: (route(t, "GET /v1/clients")["Properties"].__setitem__("AuthorizationType", "NONE"), route(t, "GET /v1/clients")["Properties"].pop("AuthorizerId", None)),
    "route_permission_added": lambda t: t["Resources"].__setitem__("ApiGETv1shiftseriesHandlerPermission0000ABCD", dict(
        copy.deepcopy(permission(t)),
        Properties=dict(permission(t)["Properties"], SourceArn={"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":execute-api:us-west-2:300094796789:", {"Ref": "ApiF70053CD"}, "/*/*/v1/shift-series"]]}))),
    "api_permission_widened": lambda t: permission(t)["Properties"].__setitem__("SourceArn", "*"),
    "handler_other_env": lambda t: res(t, "Handler8")["Properties"]["Environment"]["Variables"].__setitem__("DB_NAME", "postgres"),
    "handler_new_env": lambda t: res(t, "Handler8")["Properties"]["Environment"]["Variables"].__setitem__("SES_FROM", "x@example.com"),
    "handler_memory": lambda t: res(t, "Handler8")["Properties"].__setitem__("MemorySize", 2048),
    "handler_policy_extra": lambda t: stmts(t, "HandlerPolicy").append({"Action": "ses:SendEmail", "Effect": "Allow", "Resource": "*", "Sid": "Y"}),
    "handler_policy_widened": lambda t: next(s for s in stmts(t, "HandlerPolicy") if s["Sid"] == "SignatureObjects")["Action"].append("s3:DeleteObject"),
    "identity_env": lambda t: res(t, "IdentityHandler")["Properties"]["Environment"]["Variables"].__setitem__("DB_HOST", "x"),
    "identity_policy": lambda t: next(s for s in stmts(t, "IdentityPolicy") if s["Sid"] == "CreateCaregiverSignIns")["Action"].append("cognito-idp:AdminSetUserPassword"),
    "resource_added": lambda t: t["Resources"].__setitem__("Queue00000000", {"Type": "AWS::SQS::Queue", "Properties": {}}),
    "output_added": lambda t: t.setdefault("Outputs", {}).__setitem__("Extra", {"Value": "x"}),
}
EGRESS_MUTATIONS = {
    "egress_nat_gateway": lambda t: t["Resources"].__setitem__("Nat00000000", {"Type": "AWS::EC2::NatGateway", "Properties": {"SubnetId": "s"}}),
    "s3_endpoint_whole_bucket": lambda t: stmts(t, "S3GatewayEndpoint")[0].__setitem__("Resource", "*"),
    "lambda_endpoint_two_azs": lambda t: res(t, "LambdaEndpoint")["Properties"]["SubnetIds"].append("subnet-0000000000000000"),
}


def other_stack(cdk):
    p = os.path.join(cdk, "Ogevia-prod-EvidenceStorage.template.json")
    t = json.load(open(p))
    for r in t["Resources"].values():
        if r["Type"] == "AWS::S3::Bucket":
            r["Properties"]["VersioningConfiguration"] = {"Status": "Suspended"}
    json.dump(t, open(p, "w"))


def gate(cdk, deployed):
    return subprocess.run([sys.executable, os.path.join(HERE, "release_0034_gate.py"), "--cdk-out", cdk, "--deployed", deployed],
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
