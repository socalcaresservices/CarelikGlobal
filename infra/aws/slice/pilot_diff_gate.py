#!/usr/bin/env python3
"""Deployment scope gate for the SCS pilot (standard library only).

Compares each synthesized template (cdk.out) with the template CloudFormation
currently has deployed, and FAILS unless the only changes are the approved
pilot scope:
  - Ogevia-prod-ServiceVerificationApi: new API routes, their integrations and
    route-scoped Lambda invoke permissions; the API Lambda's code package.
  - every other stack: no resource change at all.
  - no resource is removed or replaced anywhere.
  - the API's unauthenticated routes are exactly the approved public list.
Resource Metadata (CDK asset paths) is ignored, and so is the value of the
`ogevia:deployment-status` tag: it records the approval reference by design
(lib/app.ts), so a new approval changes it on every resource. Every other tag
and property is compared. Prints a summary; exit 1 = stop.
"""
import argparse
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
API_ADDABLE = {"AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::Integration", "AWS::Lambda::Permission"}


APPROVAL_TAG = "ogevia:deployment-status"


def without_approval_tag(tags):
    if isinstance(tags, list):
        return [t for t in tags if not (isinstance(t, dict) and t.get("Key") == APPROVAL_TAG)]
    if isinstance(tags, dict):
        return {k: v for k, v in tags.items() if k != APPROVAL_TAG}
    return tags


def resources(template):
    out = {}
    for lid, r in (template.get("Resources") or {}).items():
        r = json.loads(json.dumps(r))
        r.pop("Metadata", None)
        props = r.get("Properties") or {}
        if "Tags" in props:
            props["Tags"] = without_approval_tag(props["Tags"])
        out[lid] = r
    return out


def changed_property_keys(old, new):
    keys = set()
    po, pn = old.get("Properties", {}), new.get("Properties", {})
    for k in set(po) | set(pn):
        if po.get(k) != pn.get(k):
            keys.add(k)
    for k in ("Type", "DependsOn", "Condition", "DeletionPolicy", "UpdateReplacePolicy"):
        if old.get(k) != new.get(k):
            keys.add("<%s>" % k)
    return keys


def public_route_keys(template):
    keys = []
    for r in (template.get("Resources") or {}).values():
        if r.get("Type") != "AWS::ApiGatewayV2::Route":
            continue
        props = r.get("Properties", {})
        if props.get("AuthorizationType", "NONE") == "NONE":
            keys.append(props.get("RouteKey"))
    return sorted(keys)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cdk-out", required=True, help="synthesized cloud assembly directory")
    p.add_argument("--deployed", required=True, help="directory of <stack>.json deployed templates")
    p.add_argument("--summary", help="write the summary here as well")
    args = p.parse_args()
    lines, failures = [], []

    for stack in STACKS:
        new = json.load(open(os.path.join(args.cdk_out, stack + ".template.json")))
        deployed_path = os.path.join(args.deployed, stack + ".json")
        if not os.path.exists(deployed_path):
            failures.append("%s: not deployed (this workflow never creates stacks)" % stack)
            continue
        old = json.load(open(deployed_path))
        ro, rn = resources(old), resources(new)
        added = sorted(set(rn) - set(ro))
        removed = sorted(set(ro) - set(rn))
        modified = sorted(l for l in set(ro) & set(rn) if ro[l] != rn[l])
        if not (added or removed or modified):
            lines.append("%s: no resource changes" % stack)
            continue
        for l in removed:
            failures.append("%s: would REMOVE %s (%s)" % (stack, l, ro[l]["Type"]))
        for l in added:
            t = rn[l]["Type"]
            desc = t
            if t == "AWS::ApiGatewayV2::Route":
                desc += " " + str(rn[l].get("Properties", {}).get("RouteKey"))
            if stack == API_STACK and t in API_ADDABLE:
                lines.append("%s: + %s" % (stack, desc))
            else:
                failures.append("%s: would ADD %s (%s) - outside the approved scope" % (stack, l, desc))
        for l in modified:
            t = rn[l]["Type"]
            keys = changed_property_keys(ro[l], rn[l])
            if stack == API_STACK and t == "AWS::Lambda::Function" and keys <= {"Code"}:
                lines.append("%s: ~ %s code package only" % (stack, l))
            else:
                failures.append("%s: would MODIFY %s (%s): %s" % (stack, l, t, ", ".join(sorted(keys))))

    api = json.load(open(os.path.join(args.cdk_out, API_STACK + ".template.json")))
    pub = public_route_keys(api)
    if pub == APPROVED_PUBLIC_ROUTE_KEYS:
        lines.append("Public (no sign-in) API routes: %d, exactly the approved list" % len(pub))
    else:
        failures.append("Public API routes differ from the approved list: extra %s, missing %s" % (
            sorted(set(pub) - set(APPROVED_PUBLIC_ROUTE_KEYS)), sorted(set(APPROVED_PUBLIC_ROUTE_KEYS) - set(pub))))

    out = ["Deployment scope gate"] + ["  " + l for l in lines]
    if failures:
        out += ["STOP - outside the approved scope:"] + ["  " + f for f in failures]
    else:
        out += ["Scope gate: PASS"]
    text = "\n".join(out)
    print(text)
    if args.summary:
        with open(args.summary, "w") as f:
            f.write(text + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
