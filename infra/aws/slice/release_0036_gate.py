#!/usr/bin/env python3
"""Deployment scope gate for release 0027-0036 (standard library only). STRICT.

Compares each synthesized template (cdk.out) with the template CloudFormation
has deployed (captured just before the change; base = release 0022-0026 at
0ca5616) and FAILS unless the difference is exactly this release:

ServiceVerificationApi
  1. ADD the 30 routes in NEW_ROUTES, each identical to the live GET /v1/me
     route except its RouteKey (JWT, the one existing integration), and NO
     invoke permission (the existing single API-scoped permission covers them).
  1b. ADD the 2 owner-approved public routes in NEW_PUBLIC_ROUTES (0036, visit
     confirmation link + phone code), each identical to the live public
     POST /v1/public/care-offers/{token}/respond route except its RouteKey (no
     authorizer, the same existing integration), and no invoke permission.
  2. MODIFY the existing Handler: its code package only (S3Key and the asset
     path metadata). Environment, memory, timeout, role, VPC unchanged.
  3. MODIFY the identity function, if at all: its code package only.
Everything else, in every stack, identical; nothing added or removed; the
NetworkEgress, EvidenceStorage, Observability and WebHosting stacks unchanged;
public (no sign-in) routes exactly the approved list (8 live + those 2).
No IAM policy change. Exit 1 = stop.
"""
import argparse
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import increment_diff_gate as base  # noqa: E402
from pilot_diff_gate import STACKS, API_STACK, diff_paths, handler_id, only_cdk_path, public_route_keys, without  # noqa: E402
from smoke import APPROVED_PUBLIC_ROUTE_KEYS  # noqa: E402

NEW_ROUTES = sorted([
    "GET /v1/billing-rounding/policies",
    "GET /v1/billing-rounding/preview",
    "GET /v1/continuity/status",
    "GET /v1/outage-visits/reconciliation",
    "GET /v1/reports/monthly-approval-summary",
    "GET /v1/shift-series",
    "GET /v1/shift-series/preview",
    "GET /v1/visits/{visitId}/review",
    "POST /v1/assignments/{assignmentId}/family-relationship",
    "POST /v1/billing-rounding/adjustments",
    "POST /v1/billing-rounding/adjustments/{adjustmentId}/void",
    "POST /v1/billing-rounding/policies",
    "POST /v1/caregivers/{caregiverRecordId}/employment",
    "POST /v1/continuity/pack",
    "POST /v1/document-reminder-days",
    "POST /v1/outage-visits",
    "POST /v1/outage-visits/not-used",
    "POST /v1/shift-series",
    "POST /v1/shift-series/{seriesId}/change",
    "POST /v1/shift-series/{seriesId}/end",
    "POST /v1/shift-series/{seriesId}/extend",
    "POST /v1/shifts/{shiftId}/reschedule",
    "POST /v1/visit-review-decisions/{decisionId}/revoke",
    "POST /v1/visits/{visitId}/review-decision",
    # 0036 missing-signature recovery (staff, JWT)
    "GET /v1/late-confirmations/{lateConfirmationId}/evidence",
    "GET /v1/visits/{visitId}/confirmation-requests",
    "POST /v1/late-confirmations/{lateConfirmationId}/review",
    "POST /v1/visit-confirmation-requests/{requestId}/paper",
    "POST /v1/visit-confirmation-requests/{requestId}/revoke",
    "POST /v1/visits/{visitId}/confirmation-requests",
])
NEW_PUBLIC_ROUTES = sorted([
    "POST /v1/public/visit-confirmations/{token}/open",
    "POST /v1/public/visit-confirmations/{token}/respond",
])
PUBLIC_SIBLING = "POST /v1/public/care-offers/{token}/respond"


def routes_by_key(res):
    out = {}
    for lid, r in res.items():
        if r.get("Type") == "AWS::ApiGatewayV2::Route":
            out.setdefault(r["Properties"].get("RouteKey"), []).append(lid)
    return out


def check_public_additions(old, new, added, failures, lines):
    """Each new public route equals the live public sibling except its key; returns their ids."""
    old_routes, new_routes = routes_by_key(old), routes_by_key(new)
    sib = old_routes.get(PUBLIC_SIBLING, [])
    integrations = [lid for lid, r in old.items() if r.get("Type") == "AWS::ApiGatewayV2::Integration"]
    ids = set()
    if len(sib) != 1:
        failures.append("%s: live %s route not found; cannot verify the public additions" % (API_STACK, PUBLIC_SIBLING))
        return ids
    for key in NEW_PUBLIC_ROUTES:
        if key in old_routes:
            failures.append("%s: %s is already live; this build expects it to be new" % (API_STACK, key))
            continue
        found = new_routes.get(key, [])
        if len(found) != 1 or found[0] not in added:
            failures.append("%s: expected exactly one new public route %s, found %d" % (API_STACK, key, len(found)))
            continue
        want = copy.deepcopy(old[sib[0]])
        want["Properties"]["RouteKey"] = key
        got = new[found[0]]
        bad = diff_paths(without(want, "Metadata"), without(got, "Metadata"))
        on_existing = len(integrations) == 1 and ('"Ref": "%s"' % integrations[0]) in json.dumps(got["Properties"].get("Target"))
        if bad or not on_existing or not only_cdk_path(got):
            failures.append("%s: public %s differs from the live %s route beyond its key: %s%s" % (
                API_STACK, key, PUBLIC_SIBLING, ", ".join(bad) or "Metadata", "" if on_existing else "; does not target the existing integration"))
        else:
            lines.append("%s: + public route %s (approved token link, existing integration; no per-route permission)" % (API_STACK, key))
        ids.add(found[0])
    return ids
CODE_ONLY = ("Properties.Code.S3Key", "Metadata.aws:asset:path")


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
        if stack == API_STACK:
            public_ids = check_public_additions(old, new, added, failures, lines)
            base.check_additions(old, new, [a for a in added if a not in public_ids], failures, lines)
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
            elif stack == API_STACK and t == "AWS::Lambda::Function" and (lid == h or lid.startswith("IdentityHandler")):
                bad = diff_paths(without(old[lid], *CODE_ONLY), without(new[lid], *CODE_ONLY))
                if not bad:
                    lines.append("%s: ~ %s code package only" % (stack, lid))
                    continue
            else:
                bad = diff_paths(old[lid], new[lid])
            failures.append("%s: would MODIFY %s (%s): %s" % (stack, lid, t, ", ".join(bad)))

    api_new = json.load(open(os.path.join(args.cdk_out, API_STACK + ".template.json")))
    pub = public_route_keys(api_new)
    if pub == APPROVED_PUBLIC_ROUTE_KEYS:
        lines.append("Public (no sign-in) API routes: %d, exactly the approved list (+%d visit-confirmation links)" % (len(pub), len(NEW_PUBLIC_ROUTES)))
    else:
        failures.append("Public API routes differ from the approved list: extra %s, missing %s" % (
            sorted(set(pub) - set(APPROVED_PUBLIC_ROUTE_KEYS)), sorted(set(APPROVED_PUBLIC_ROUTE_KEYS) - set(pub))))

    out = ["Deployment scope gate, release 0027-0036 (strict)"] + ["  " + line for line in lines]
    out += (["STOP - outside the approved change:"] + ["  " + f for f in failures]) if failures else ["Scope gate: PASS"]
    text = "\n".join(out)
    print(text)
    if args.summary:
        with open(args.summary, "w") as f:
            f.write(text + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
