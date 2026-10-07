#!/usr/bin/env python3
"""Deployment scope gate for the SCS pilot (standard library only). STRICT.

Compares each synthesized template (cdk.out) with the template CloudFormation
has deployed (captured before any change) and FAILS unless the difference is
exactly the approved pilot change:

  1. ADD  route  POST /v1/visits/{visitId}/close, identical to the live
     POST /v1/visits/{visitId}/end route except its RouteKey (same API, JWT
     authorizer and target integration). No new integration: it must target
     the API's one existing integration, which invokes the existing Handler.
  2. ADD  its Lambda invoke permission, identical to the live permission of
     .../end except the route path in SourceArn.
  3. MODIFY the existing Handler's code package only: Properties.Code.S3Key
     and Metadata aws:asset:path may differ; everything else (Code.S3Bucket,
     environment, role, VPC, tags, ...) must be identical.
  4. MODIFY AWS::CDK::Metadata Properties.Analytics only (CDK version/construct
     analytics; creates nothing in AWS); every other attribute identical.

Every other resource, and every attribute of every resource (Type,
Properties, Metadata, DependsOn, Condition, policies), must be identical.
Template sections (Description, Parameters, Rules, Conditions, Mappings,
Outputs) must be identical. Nothing may be removed. Tags are compared too,
so the build must be synthesized with the live approval tag value.
Prints a summary; exit 1 = stop.
"""
import argparse
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import APPROVED_PUBLIC_ROUTE_KEYS  # noqa: E402

STACKS = [
    "Ogevia-prod-EvidenceStorage",
    "Ogevia-prod-NetworkEgress",
    "Ogevia-prod-WebHosting",
    "Ogevia-prod-ServiceVerificationApi",
    "Ogevia-prod-Observability",
]
API_STACK = "Ogevia-prod-ServiceVerificationApi"
NEW_ROUTE = "POST /v1/visits/{visitId}/close"
SIBLING_ROUTE = "POST /v1/visits/{visitId}/end"
NEW_PATH, SIBLING_PATH = "/v1/visits/{visitId}/close", "/v1/visits/{visitId}/end"


def diff_paths(a, b, path=""):
    """Every attribute path where a and b differ (recursive, exact)."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b), key=str):
            p = "%s.%s" % (path, k) if path else str(k)
            if k not in a or k not in b:
                out.append(p)
            else:
                out += diff_paths(a[k], b[k], p)
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff_paths(x, y, "%s[%d]" % (path, i))
        return out
    return [] if a == b else [path or "<root>"]


def without(resource, *paths):
    """Deep copy with the given dotted paths removed (missing paths ignored)."""
    r = copy.deepcopy(resource)
    for p in paths:
        node, parts = r, p.split(".")
        for part in parts[:-1]:
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, dict):
            node.pop(parts[-1], None)
    return r


def public_route_keys(template):
    return sorted(r["Properties"].get("RouteKey") for r in template.get("Resources", {}).values()
                  if r.get("Type") == "AWS::ApiGatewayV2::Route"
                  and r.get("Properties", {}).get("AuthorizationType", "NONE") == "NONE")


def find_route(res, key):
    hits = [lid for lid, r in res.items() if r.get("Type") == "AWS::ApiGatewayV2::Route"
            and r.get("Properties", {}).get("RouteKey") == key]
    return hits[0] if len(hits) == 1 else None


def find_permission(res, path):
    hits = [lid for lid, r in res.items() if r.get("Type") == "AWS::Lambda::Permission"
            and json.dumps(r.get("Properties", {}).get("SourceArn")).endswith('/*/*%s"]]}' % path)]
    return hits[0] if len(hits) == 1 else None


def only_cdk_path(resource):
    return not (set((resource.get("Metadata") or {})) - {"aws:cdk:path"})


def check_api_additions(old, new, added, failures, lines):
    """The two approved additions, each matched exactly against live siblings."""
    sib_route = find_route(old, SIBLING_ROUTE)
    sib_perm = find_permission(old, SIBLING_PATH)
    if not sib_route or not sib_perm:
        failures.append("%s: live %s route/permission not found; cannot verify the addition" % (API_STACK, SIBLING_ROUTE))
        return
    route_id = find_route(new, NEW_ROUTE)
    perm_id = find_permission(new, NEW_PATH)
    if route_id is None or perm_id is None or set(added) != {route_id, perm_id}:
        failures.append("%s: additions must be exactly the %s route and its permission; got: %s" % (
            API_STACK, NEW_ROUTE, ", ".join("%s (%s)" % (l, new[l]["Type"]) for l in added) or "none"))
        return
    ok = True
    want = copy.deepcopy(old[sib_route])
    want["Properties"]["RouteKey"] = NEW_ROUTE
    got = new[route_id]
    bad = diff_paths(without(want, "Metadata"), without(got, "Metadata"))
    if bad or not only_cdk_path(got):
        ok = False
        failures.append("%s: %s differs from the live %s route beyond its RouteKey: %s" % (
            API_STACK, NEW_ROUTE, SIBLING_ROUTE, ", ".join(bad) or "Metadata"))
    target = json.dumps(got["Properties"].get("Target"))
    if not any(r.get("Type") == "AWS::ApiGatewayV2::Integration" and ('"Ref": "%s"' % lid) in target
               for lid, r in old.items()):
        ok = False
        failures.append("%s: %s does not target an existing integration" % (API_STACK, NEW_ROUTE))
    want_p = json.loads(json.dumps(old[sib_perm]).replace(SIBLING_PATH, NEW_PATH))
    got_p = new[perm_id]
    bad = diff_paths(without(want_p, "Metadata"), without(got_p, "Metadata"))
    if bad or not only_cdk_path(got_p):
        ok = False
        failures.append("%s: the %s permission differs from the live %s permission beyond its path: %s" % (
            API_STACK, NEW_ROUTE, SIBLING_ROUTE, ", ".join(bad) or "Metadata"))
    if ok:
        lines.append("%s: + route %s (identical to live %s except RouteKey; existing integration, no new one)" % (
            API_STACK, NEW_ROUTE, SIBLING_ROUTE))
        lines.append("%s: + its route-scoped invoke permission (identical to the live %s permission except path)" % (
            API_STACK, SIBLING_ROUTE))


def handler_id(old):
    """The Lambda function the API's single live integration invokes."""
    integ = [r for r in old.values() if r.get("Type") == "AWS::ApiGatewayV2::Integration"]
    if len(integ) != 1:
        return None
    uri = integ[0].get("Properties", {}).get("IntegrationUri", {})
    target = (uri.get("Fn::GetAtt") or [None])[0] if isinstance(uri, dict) else None
    return target if target in old and old[target].get("Type") == "AWS::Lambda::Function" else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cdk-out", required=True, help="synthesized cloud assembly directory")
    p.add_argument("--deployed", required=True, help="directory of <stack>.json deployed templates")
    p.add_argument("--summary", help="write the summary here as well")
    args = p.parse_args()
    lines, failures = [], []

    for stack in STACKS:
        new_t = json.load(open(os.path.join(args.cdk_out, stack + ".template.json")))
        path = os.path.join(args.deployed, stack + ".json")
        if not os.path.exists(path):
            failures.append("%s: not deployed (this workflow never creates stacks)" % stack)
            continue
        old_t = json.load(open(path))
        sections = diff_paths({k: v for k, v in old_t.items() if k != "Resources"},
                              {k: v for k, v in new_t.items() if k != "Resources"})
        for s in sections:
            failures.append("%s: template section differs: %s" % (stack, s))
        old, new = old_t.get("Resources", {}), new_t.get("Resources", {})
        added = sorted(set(new) - set(old))
        removed = sorted(set(old) - set(new))
        modified = sorted(l for l in set(old) & set(new) if old[l] != new[l])
        if not (added or removed or modified or sections):
            lines.append("%s: no changes" % stack)
            continue
        for l in removed:
            failures.append("%s: would REMOVE %s (%s)" % (stack, l, old[l]["Type"]))
        if stack == API_STACK:
            if added:
                check_api_additions(old, new, added, failures, lines)
        else:
            for l in added:
                failures.append("%s: would ADD %s (%s)" % (stack, l, new[l]["Type"]))
        h = handler_id(old) if stack == API_STACK else None
        for l in modified:
            t = new[l]["Type"]
            if t == "AWS::CDK::Metadata" and old[l].get("Type") == t:
                bad = diff_paths(without(old[l], "Properties.Analytics"), without(new[l], "Properties.Analytics"))
                if not bad:
                    lines.append("%s: ~ CDK metadata Analytics only (creates nothing in AWS)" % stack)
                    continue
            elif l == h:
                bad = diff_paths(without(old[l], "Properties.Code.S3Key", "Metadata.aws:asset:path"),
                                 without(new[l], "Properties.Code.S3Key", "Metadata.aws:asset:path"))
                if not bad:
                    lines.append("%s: ~ %s (the existing Handler) code package only: Code.S3Key" % (stack, l))
                    continue
            else:
                bad = diff_paths(old[l], new[l])
            failures.append("%s: would MODIFY %s (%s): %s" % (stack, l, t, ", ".join(bad)))

    api_new = json.load(open(os.path.join(args.cdk_out, API_STACK + ".template.json")))
    pub = public_route_keys(api_new)
    live_path = os.path.join(args.deployed, API_STACK + ".json")
    if os.path.exists(live_path):
        live_pub = set(public_route_keys(json.load(open(live_path))))
        for key in pub:
            lines.append("Public route %s: %s" % (key, "already live" if key in live_pub else "ADDED by this deployment"))
    if pub == APPROVED_PUBLIC_ROUTE_KEYS:
        lines.append("Public (no sign-in) API routes: %d, exactly the approved list" % len(pub))
    else:
        failures.append("Public API routes differ from the approved list: extra %s, missing %s" % (
            sorted(set(pub) - set(APPROVED_PUBLIC_ROUTE_KEYS)), sorted(set(APPROVED_PUBLIC_ROUTE_KEYS) - set(pub))))

    out = ["Deployment scope gate (strict)"] + ["  " + l for l in lines]
    out += (["STOP - outside the approved change:"] + ["  " + f for f in failures]) if failures else ["Scope gate: PASS"]
    text = "\n".join(out)
    print(text)
    if args.summary:
        with open(args.summary, "w") as f:
            f.write(text + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
