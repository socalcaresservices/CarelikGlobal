#!/usr/bin/env python3
"""Proves the increment scope gate is not vacuous, on the real templates.

Given the synthesized build (--cdk-out) and the deployed templates
(--deployed), the gate must PASS on them as they are, and must FAIL on each
tampered copy below (one change each, applied to the build side). Read-only:
works on copies in a temporary directory. Exit 1 if any expectation fails.
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


def res_of(t, typ, pred=lambda lid, r: True):
    return [lid for lid, r in t["Resources"].items() if r["Type"] == typ and pred(lid, r)]


def policy(t):
    return t["Resources"][res_of(t, "AWS::IAM::ManagedPolicy", lambda lid, r: lid.startswith("HandlerPolicy"))[0]]


def new_route(t, key):
    return t["Resources"][res_of(t, "AWS::ApiGatewayV2::Route", lambda lid, r: r["Properties"]["RouteKey"] == key)[0]]


def handler(t):
    return t["Resources"][res_of(t, "AWS::Lambda::Function")[0]]


def m_delete_action(t):
    for s in policy(t)["Properties"]["PolicyDocument"]["Statement"]:
        if s.get("Sid") == "AgencyLogoObjects":
            s["Action"] = s["Action"] + ["s3:DeleteObject"]


def m_wide_resource(t):
    for s in policy(t)["Properties"]["PolicyDocument"]["Statement"]:
        if s.get("Sid") == "StaffDocumentObjects":
            s["Resource"] = s["Resource"].split("/")[0] + "/*"


def m_third_statement(t):
    policy(t)["Properties"]["PolicyDocument"]["Statement"].append(
        {"Action": "s3:ListBucket", "Effect": "Allow", "Resource": "*", "Sid": "Extra"})


def m_existing_statement(t):
    for s in policy(t)["Properties"]["PolicyDocument"]["Statement"]:
        if s.get("Sid") == "SignatureObjects":
            s["Action"] = s["Action"] + ["s3:DeleteObject"]


def m_route_public(t):
    p = new_route(t, "GET /v1/documents")["Properties"]
    p["AuthorizationType"] = "NONE"
    p.pop("AuthorizerId", None)


def m_extra_route(t):
    src = new_route(t, "GET /v1/documents")
    r = copy.deepcopy(src)
    r["Properties"]["RouteKey"] = "DELETE /v1/documents"
    t["Resources"]["ApiDELETEv1documents0000ABCD"] = r


def m_missing_route(t):
    lid = res_of(t, "AWS::ApiGatewayV2::Route", lambda lid, r: r["Properties"]["RouteKey"] == "GET /v1/attention")[0]
    del t["Resources"][lid]


def m_memory(t):
    handler(t)["Properties"]["MemorySize"] = 1024


def m_env(t):
    handler(t)["Properties"]["Environment"]["Variables"]["DB_NAME"] = "postgres"


def m_remove_resource(t):
    del t["Resources"][res_of(t, "AWS::Logs::LogGroup")[0]]


def m_permission_wildcard(t):
    lid = res_of(t, "AWS::Lambda::Permission", lambda lid, r: "attention" in json.dumps(r))[0]
    t["Resources"][lid]["Properties"]["SourceArn"] = "*"


def m_tag(t):
    for r in t["Resources"].values():
        for tag in r.get("Properties", {}).get("Tags") or []:
            if isinstance(tag, dict) and tag.get("Key") == "ogevia:deployment-status":
                tag["Value"] = "not-approved"
                return


def m_output(t):
    t.setdefault("Outputs", {})["Extra"] = {"Value": "x"}


API_MUTATIONS = [m_delete_action, m_wide_resource, m_third_statement, m_existing_statement, m_route_public,
                 m_extra_route, m_missing_route, m_memory, m_env, m_remove_resource, m_permission_wildcard,
                 m_tag, m_output]


def m_other_stack(cdk):
    p = os.path.join(cdk, "Ogevia-prod-EvidenceStorage.template.json")
    t = json.load(open(p))
    for r in t["Resources"].values():
        if r["Type"] == "AWS::S3::Bucket":
            r["Properties"]["VersioningConfiguration"] = {"Status": "Suspended"}
    json.dump(t, open(p, "w"))


def gate(cdk, deployed):
    return subprocess.run([sys.executable, os.path.join(HERE, "increment_diff_gate.py"), "--cdk-out", cdk,
                           "--deployed", deployed], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1")).returncode


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--cdk-out", required=True)
    a.add_argument("--deployed", required=True)
    args = a.parse_args()
    ok = True
    rc = gate(args.cdk_out, args.deployed)
    print("%s gate passes the untampered build" % ("PASS" if rc == 0 else "FAIL"))
    ok &= rc == 0
    with tempfile.TemporaryDirectory() as tmp:
        cases = [(f.__name__[2:], f, True) for f in API_MUTATIONS] + [("other_stack_change", m_other_stack, False)]
        for name, fn, on_api in cases:
            cdk = os.path.join(tmp, name)
            os.mkdir(cdk)
            for f in os.listdir(args.cdk_out):
                if f.endswith(".template.json"):
                    shutil.copy(os.path.join(args.cdk_out, f), cdk)
            if on_api:
                p = os.path.join(cdk, API + ".template.json")
                t = json.load(open(p))
                fn(t)
                json.dump(t, open(p, "w"))
            else:
                fn(cdk)
            rc = gate(cdk, args.deployed)
            print("%s gate refuses: %s" % ("PASS" if rc == 1 else "FAIL", name))
            ok &= rc == 1
    print("Gate self-test: %s" % ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
