#!/usr/bin/env python3
"""TEST two-agency isolation over the deployed API (standard library only; SYNTHETIC data; TEST database only).

Needs two NEW agencies with one owner each, created by `db-window-run.sh test isolation-seed` (seed file passed with --seed).
  edge     over HTTPS to the API Gateway URL: anonymous and forged-token requests are refused (401). The real JWT authorizer.
  start    each new agency's owner resolves to exactly one membership (their own agency) and every list is empty.
  isolate  A creates a client; B still sees nothing; B cannot read, list, or change A's client by naming A's agency or A's client id;
           the same in the other direction; forged role/agency claims for A's sign-in grant nothing in B.
Requests go through the API handler (Invoker: IAM-gated invoke with API-Gateway-shaped events carrying the owner's sub), the established
TEST method; real browser sign-in needs an authenticator-app code (MFA is ON), so it is NOT part of this script. Prints ids, never names or tokens.
Exit 0 = every check passed, 1 = a check failed, 2 = could not run."""
import argparse
import datetime
import json
import os
import sys
import types
import uuid

import subprocess, tempfile, time, urllib.error, urllib.request

REGION = "us-west-2"
POOL = "us-west-2_849AYz5J7"
API_STACK_NAME = "Ogevia-prod-ServiceVerificationApi"
RESULTS = []


def check(area, name, ok, detail=""):
    RESULTS.append((area, name, bool(ok), detail))
    print("  %s  %-14s %s%s" % ("PASS" if ok else "FAIL", area, name, (" (" + detail + ")") if detail and not ok else ""), flush=True)
    return bool(ok)


def guarded(area, name, fn):
    try:
        return fn()
    except Exception as exc:
        check(area, name, False, "%s: %s" % (type(exc).__name__, str(exc)[:200]))
        return None


def aws(*args):
    out = subprocess.run(["aws", *args, "--region", REGION, "--output", "json"], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300])
    return json.loads(out.stdout) if out.stdout.strip() else {}


def http(url, method="GET", headers=None, body=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict((k.lower(), v) for k, v in r.headers.items()), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict((k.lower(), v) for k, v in e.headers.items()), e.read()


def find_api_function(stack=API_STACK_NAME):
    """Physical name of the API handler Lambda in the pilot API stack.

    Uses list-stack-resources (read-only, paginated by the CLI) and the logical id "Handler": the stack also holds the
    "IdentityHandler" Lambda and may hold helper Lambdas, so "the first Lambda in the stack" is not a safe choice. If the
    handler is not found, stop with a message that says what was found, instead of an IndexError."""
    res = aws("cloudformation", "list-stack-resources", "--stack-name", stack)
    items = res.get("StackResourceSummaries", [])
    fns = [r for r in items if r.get("ResourceType") == "AWS::Lambda::Function"]
    handler = [r for r in fns if r.get("LogicalResourceId", "").startswith("Handler")]
    if len(handler) == 1:
        return handler[0]["PhysicalResourceId"]
    raise RuntimeError(
        "cannot identify the API handler Lambda in stack %s: %d resources listed, %d Lambda functions (%s), %d match logical id 'Handler*'. "
        "Check the stack name, the region (%s) and the credentials; nothing was invoked."
        % (stack, len(items), len(fns), ", ".join(sorted(r.get("LogicalResourceId", "?") for r in fns)) or "none", len(handler), REGION))


class Invoker:
    def __init__(self, args, client_id):
        self.args = args
        self.client_id = client_id
        self.function = None
        if args.mode == "aws":
            self.function = find_api_function()

    def claims(self, sub, extra=None):
        c = {"sub": sub, "iss": "https://cognito-idp.%s.amazonaws.com/%s" % (REGION, self.args.pool),
             "client_id": self.client_id, "token_use": "access", "scope": "openid email",
             "exp": str(int(time.time()) + 600)}
        c.update(extra or {})
        return c

    def call(self, route, sub, path=None, query=None, body=None, key=None, claims=None):
        headers = {}
        if route.startswith("POST"):
            headers["idempotency-key"] = key or str(uuid.uuid4())
        event = {"routeKey": route, "headers": headers, "pathParameters": path or {},
                 "queryStringParameters": query or {}, "body": json.dumps(body) if body is not None else None,
                 "requestContext": {"requestId": "smoke-" + uuid.uuid4().hex[:8]}}
        if sub is not None or claims is not None:
            event["requestContext"]["authorizer"] = {"jwt": {"claims": claims or self.claims(sub)}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(event, f)
            event_file = f.name
        try:
            if self.args.mode == "aws":
                out_file = event_file + ".out"
                r = subprocess.run(["aws", "lambda", "invoke", "--region", REGION, "--function-name", self.function,
                                    "--cli-binary-format", "raw-in-base64-out", "--payload", "file://" + event_file,
                                    out_file], capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(r.stderr.strip()[:300])
                with open(out_file) as f:
                    resp = json.load(f)
                os.unlink(out_file)
            else:
                r = subprocess.run(self.args.local_invoker, shell=True, input=json.dumps(event), capture_output=True, text=True)
                if r.returncode != 0:
                    raise RuntimeError(r.stderr.strip()[-300:])
                resp = json.loads(r.stdout.strip().splitlines()[-1])
        finally:
            os.unlink(event_file)
        if "statusCode" not in resp:
            raise RuntimeError("Lambda error: " + json.dumps(resp)[:200])
        return resp["statusCode"], json.loads(resp.get("body") or "null")



T = "isolation"
DENIED = (400, 401, 403, 404)


def rows_of(body, key):
    return (body or {}).get(key, []) if isinstance(body, dict) else []


def leaks(status, body, key):
    """True if the response hands back rows."""
    return status == 200 and len(rows_of(body, key)) > 0


def run(inv, seed, api_url=None):
    A, B = seed["a"], seed["b"]
    today = datetime.date.today()
    window = {"from": today.isoformat(), "to": (today + datetime.timedelta(days=120)).isoformat()}
    ok = check

    if api_url:
        for label, headers in (("anonymous", {}), ("forged token", {"authorization": "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.x"}),
                               ("malformed token", {"authorization": "Bearer not-a-token"})):
            s, _, _ = http(api_url + "/v1/clients?organizationId=" + A["org"], headers=headers)
            ok(T, "edge: %s request to /v1/clients -> 401" % label, s == 401, "got %s" % s)
            s, _, _ = http(api_url + "/v1/me", headers=headers)
            ok(T, "edge: %s request to /v1/me -> 401" % label, s == 401, "got %s" % s)

    for name, me_, other in (("A", A, B), ("B", B, A)):
        s, me = inv.call("GET /v1/me", me_["sub"])
        ms = (me or {}).get("memberships", [])
        ok(T, "start: owner %s has exactly one membership, owner of their own new agency" % name,
           s == 200 and len(ms) == 1 and ms[0].get("organizationId") == me_["org"] and ms[0].get("role") == "organization_owner", "status %s, memberships %s" % (s, len(ms)))
        for route, key, query in (("GET /v1/clients", "clients", {}), ("GET /v1/caregivers", "caregivers", {}), ("GET /v1/open-shifts", "shifts", {}),
                                  ("GET /v1/shifts", "shifts", window), ("GET /v1/clients/directory", "clients", {})):
            s, b = inv.call(route, me_["sub"], query=dict(query, organizationId=me_["org"]))
            ok(T, "start: owner %s, %s is empty" % (name, route.split(" ")[1]), s == 200 and not rows_of(b, key), "status %s, rows %s" % (s, len(rows_of(b, key))))

    created = {}
    for name, me_ in (("A", A), ("B", B)):
        s, b = inv.call("POST /v1/clients", me_["sub"], body={"organizationId": me_["org"], "firstName": "Isolation", "lastName": "Synthetic" + name, "city": "Testville"})
        cid = ((b or {}).get("client") or {}).get("clientId")
        ok(T, "isolate: owner %s creates one synthetic client in their own agency" % name, s == 201 and bool(cid), "status %s" % s)
        created[name] = cid

    for name, me_, other_name, other in (("A", A, "B", B), ("B", B, "A", A)):
        theirs, mine = created[other_name], created[name]
        s, b = inv.call("GET /v1/clients", me_["sub"], query={"organizationId": me_["org"]})
        ids = [c.get("clientId") for c in rows_of(b, "clients")]
        ok(T, "isolate: owner %s sees exactly their own client, not %s's" % (name, other_name), s == 200 and ids == [mine], "status %s, %d clients" % (s, len(ids)))
        s, b = inv.call("GET /v1/clients", me_["sub"], query={"organizationId": other["org"]})
        ok(T, "isolate: owner %s listing agency %s's clients gets nothing" % (name, other_name), not leaks(s, b, "clients") and s in (200,) + DENIED, "status %s" % s)
        for org_label, org in (("agency %s" % other_name, other["org"]), ("own agency", me_["org"])):
            s, b = inv.call("GET /v1/clients/{clientId}", me_["sub"], path={"clientId": theirs}, query={"organizationId": org})
            ok(T, "isolate: owner %s reading %s's client by id (%s) -> not found/denied" % (name, other_name, org_label), s in DENIED and not (b or {}).get("client"), "status %s" % s)
        for route, key, query in (("GET /v1/caregivers", "caregivers", {}), ("GET /v1/open-shifts", "shifts", {}), ("GET /v1/shifts", "shifts", window)):
            s, b = inv.call(route, me_["sub"], query=dict(query, organizationId=other["org"]))
            ok(T, "isolate: owner %s, %s for agency %s returns nothing" % (name, route.split(" ")[1], other_name), not leaks(s, b, key), "status %s" % s)
        s, b = inv.call("POST /v1/clients/{clientId}/details", me_["sub"], path={"clientId": theirs},
                        body={"organizationId": other["org"], "firstName": "Changed", "lastName": "ByTheOtherAgency"})
        ok(T, "isolate: owner %s cannot change %s's client" % (name, other_name), not (200 <= s < 300), "status %s" % s)
        s, b = inv.call("POST /v1/clients", me_["sub"], body={"organizationId": other["org"], "firstName": "Planted", "lastName": "ByTheOtherAgency"})
        ok(T, "isolate: owner %s cannot create a client inside agency %s" % (name, other_name), not (200 <= s < 300), "status %s" % s)
        forged = inv.claims(me_["sub"], {"cognito:groups": ["organization_owner"], "custom:role": "organization_owner", "custom:organization_id": other["org"]})
        s, b = inv.call("GET /v1/clients", None, claims=forged, query={"organizationId": other["org"]})
        ok(T, "isolate: forged agency/role claims for owner %s grant nothing in %s" % (name, other_name), not leaks(s, b, "clients"), "status %s" % s)

    for name, me_, other_name in (("A", A, "B"), ("B", B, "A")):
        s, b = inv.call("GET /v1/clients", me_["sub"], query={"organizationId": me_["org"]})
        ids = [c.get("clientId") for c in rows_of(b, "clients")]
        ok(T, "after: agency %s still holds exactly its one client; nothing planted or changed" % name, s == 200 and ids == [created[name]], "%d clients" % len(ids))
        s, b = inv.call("GET /v1/clients/{clientId}", me_["sub"], path={"clientId": created[name]}, query={"organizationId": me_["org"]})
        c = (b or {}).get("client") or {}
        ok(T, "after: agency %s's client name is unchanged" % name, s == 200 and c.get("legalFirstName") == "Isolation" and c.get("legalLastName") == "Synthetic" + name)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seed", required=True, help="JSON file written by `db-window-run.sh test isolation-seed`")
    p.add_argument("--mode", choices=["aws", "local"], default="aws")
    p.add_argument("--local-invoker")
    p.add_argument("--client-id", help="local mode: app client id the local handler accepts")
    p.add_argument("--pool", default=POOL)
    args = p.parse_args()
    seed = json.load(open(args.seed))
    for k in ("a", "b"):
        for f in ("org", "sub"):
            uuid.UUID(seed[k][f])
    print("\nOgevia TEST two-agency isolation over the API (%s mode)" % args.mode, flush=True)
    api_url = client_id = None
    if args.mode == "aws":
        def outputs(stack):
            return {o["OutputKey"]: o["OutputValue"] for o in aws("cloudformation", "describe-stacks", "--stack-name", stack)["Stacks"][0].get("Outputs", [])}
        api_url, client_id = outputs(API_STACK_NAME).get("ApiUrl"), outputs("Ogevia-prod-WebHosting").get("TestAppClientId")
        if not api_url or not client_id:
            print("STOP: the API stack has no ApiUrl output or the WebHosting stack has no TestAppClientId; nothing was called.")
            sys.exit(2)
    else:
        client_id = args.client_id
    inv = Invoker(types.SimpleNamespace(mode=args.mode, pool=args.pool, local_invoker=args.local_invoker), client_id)
    guarded(T, "isolation checks", lambda: run(inv, seed, api_url))
    failed = [r for r in RESULTS if not r[2]]
    print("\n%d checks, %d passed, %d failed" % (len(RESULTS), len(RESULTS) - len(failed), len(failed)), flush=True)
    for r in failed:
        print("  FAILED: [%s] %s %s" % (r[0], r[1], r[3]), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
