#!/usr/bin/env python3
"""Validates the resource-based policy of the Ogevia API handler Lambda: SIZE and PRINCIPALS. Read-only: it only reads a policy file.

  python3 lambda_policy_check.py --mode pre|post --policy-file FILE --function-arn ARN --account ID --region R --api-id ID [--rule-name NAME]

Every statement must be exactly one of the two shapes below; anything else (a wildcard or account principal, another service, another action,
another resource, a missing or different SourceArn condition, Deny, NotPrincipal, NotAction) is a FAILURE, not a warning:
  API Gateway : Effect Allow, Principal {"Service":"apigateway.amazonaws.com"}, Action lambda:InvokeFunction, Resource <function ARN>,
                Condition {"ArnLike":{"AWS:SourceArn": "arn:aws:execute-api:<region>:<account>:<api id>/..."}}
  EventBridge : Effect Allow, Principal {"Service":"events.amazonaws.com"}, Action lambda:InvokeFunction, Resource <function ARN>,
                Condition {"ArnLike":{"AWS:SourceArn": "arn:aws:events:<region>:<account>:rule/<rule name or its ComplianceSweep prefix>"}}
Size (bytes of the policy document as returned): fails at or above the limit 20480; the projected peak during a CloudFormation update (the new
statements are added before old ones are removed) is size + 2 x the largest statement + 2; it fails at or above the gate (default 19000).
  pre : before the deployment. At least one API Gateway statement; EventBridge statements allowed (an earlier deployment may have added one).
  post: after the deployment. At least one API Gateway statement and EXACTLY ONE EventBridge statement; size below the gate.
Exit 0 = every check passed; 1 = a check failed; 2 = usage or unreadable input.
"""
import argparse, json, sys

LIMIT = 20480
APIGW, EVENTS = "apigateway.amazonaws.com", "events.amazonaws.com"
SWEEP_PREFIX = "Ogevia-prod-ServiceVerificationApi-ComplianceSweep"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["pre", "post"])
    ap.add_argument("--policy-file", required=True)
    ap.add_argument("--function-arn", required=True)
    ap.add_argument("--account", required=True)
    ap.add_argument("--region", required=True)
    ap.add_argument("--api-id", required=True)
    ap.add_argument("--rule-name", default="")
    ap.add_argument("--gate", type=int, default=19000)
    a = ap.parse_args(argv)
    try:
        raw = open(a.policy_file, encoding="utf-8").read().strip()
        doc = json.loads(raw)
    except (OSError, ValueError) as e:
        print("FAIL policy: cannot read or parse the policy document (%s)" % e)
        return 2
    problems, apigw, events, sizes = [], 0, 0, []
    if doc.get("Version") != "2012-10-17":
        problems.append("Version is %r, expected '2012-10-17'" % doc.get("Version"))
    statements = doc.get("Statement")
    if not isinstance(statements, list) or not statements:
        print("FAIL policy: no statements (an API handler with no invoke permission cannot serve requests)")
        return 1
    api_prefix = "arn:aws:execute-api:%s:%s:%s/" % (a.region, a.account, a.api_id)
    rule_prefix = "arn:aws:events:%s:%s:rule/" % (a.region, a.account)
    for i, s in enumerate(statements):
        sid = str(s.get("Sid", "#%d" % i)) if isinstance(s, dict) else "#%d" % i
        sizes.append(len(json.dumps(s, separators=(",", ":"))))
        if not isinstance(s, dict):
            problems.append("%s: not an object" % sid); continue
        extra = set(s) - {"Sid", "Effect", "Principal", "Action", "Resource", "Condition"}
        if extra:
            problems.append("%s: unexpected keys %s (NotPrincipal/NotAction/NotResource are never accepted)" % (sid, sorted(extra)))
        if s.get("Effect") != "Allow":
            problems.append("%s: Effect is %r, expected Allow" % (sid, s.get("Effect")))
        if s.get("Action") != "lambda:InvokeFunction":
            problems.append("%s: Action is %r, expected exactly lambda:InvokeFunction" % (sid, s.get("Action")))
        if s.get("Resource") != a.function_arn:
            problems.append("%s: Resource is %r, expected this function %s" % (sid, s.get("Resource"), a.function_arn))
        p = s.get("Principal")
        svc = p.get("Service") if isinstance(p, dict) and set(p) == {"Service"} else None
        cond = s.get("Condition")
        arn = None
        if isinstance(cond, dict) and set(cond) == {"ArnLike"} and isinstance(cond["ArnLike"], dict) and set(cond["ArnLike"]) == {"AWS:SourceArn"}:
            arn = cond["ArnLike"]["AWS:SourceArn"]
        if svc == APIGW:
            apigw += 1
            if not (isinstance(arn, str) and arn.startswith(api_prefix)):
                problems.append("%s: API Gateway statement is not limited to this API (SourceArn %r, expected prefix %s)" % (sid, arn, api_prefix))
        elif svc == EVENTS:
            events += 1
            ok = isinstance(arn, str) and arn.startswith(rule_prefix) and (arn[len(rule_prefix):] == a.rule_name if a.rule_name else arn[len(rule_prefix):].startswith(SWEEP_PREFIX))
            if not ok:
                problems.append("%s: EventBridge statement is not limited to the ComplianceSweep rule (SourceArn %r)" % (sid, arn))
        else:
            problems.append("%s: principal %r is not apigateway.amazonaws.com or events.amazonaws.com" % (sid, p))
    if apigw < 1:
        problems.append("no API Gateway invoke statement")
    if a.mode == "post" and events != 1:
        problems.append("expected exactly one EventBridge statement after the deployment, found %d" % events)
    size = len(raw.encode("utf-8"))
    largest = max(sizes)
    peak = size + 2 * largest + 2
    print("statements: %d (API Gateway %d, EventBridge %d) | bytes now: %d | largest statement: %d | projected peak: %d | limit %d | gate %d" % (len(statements), apigw, events, size, largest, peak, LIMIT, a.gate))
    if size >= LIMIT:
        problems.append("the policy is already at or above the %d-byte limit" % LIMIT)
    limit_value = size if a.mode == "post" else peak
    if limit_value >= a.gate:
        problems.append("%s %d is at or above the gate %d" % ("size" if a.mode == "post" else "projected peak", limit_value, a.gate))
    for p in problems:
        print("FAIL " + p)
    print("PASS all checks (size and principals)" if not problems else "STOP: %d check(s) failed" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
