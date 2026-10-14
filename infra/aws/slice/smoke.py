#!/usr/bin/env python3
"""Ogevia TEST-slice automated smoke suite (standard library only).

Modes
  aws   (default) after deployment, from CloudShell. Read-only AWS checks plus the
        complete Service Verification workflow through the deployed Lambda, using
        the two SEEDED synthetic test identities (Cognito subs) and SYNTHETIC data.
  local --local-invoker CMD --age-cmd CMD: the same workflow against a local
        PostgreSQL, used to test this script itself.

The workflow invokes the Lambda directly with API-Gateway-shaped events carrying
the seeded subs. That is IAM-gated (administrator credentials) and exercises the
Lambda -> RDS -> S3/KMS path; the API Gateway JWT authorizer is checked
separately over HTTPS (anonymous and forged tokens must get 401).

Never prints tokens, passwords, or signature bytes.
"""
import argparse
import base64
import datetime
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
import zoneinfo

REGION = "us-west-2"
ACCOUNT = "300094796789"
POOL = "us-west-2_849AYz5J7"
APP_SG = "sg-064ffce3bcbe8eb3b"
RDS_SG = "sg-00530a1f4f7648e65"
RDS_ID = "ogevia-prod-postgres"
EVIDENCE_BUCKET = "ogevia-prod-signature-evidence-%s-%s" % (ACCOUNT, REGION)
EXISTING_CLIENT = "1i27abbina08fvg1i9u8vprgo9"
TEST_ORG_SLUG = "ogevia-test-slice"
EXPECTED_ROUTES = 38
# Must equal infra/aws/lib/public-routes.ts (checked by a unit test).
APPROVED_PUBLIC_ROUTE_KEYS = sorted([
    "GET /v1/public/care-portals/{token}",
    "GET /v1/public/care-portals/{token}/requests",
    "POST /v1/public/care-portals/{token}/requests",
    "GET /v1/public/care-portals/{token}/requests/{requestId}",
    "POST /v1/public/care-portals/{token}/requests/{requestId}/cancel",
    "GET /v1/public/care-offers/{token}",
    "POST /v1/public/care-offers/{token}/respond",
    "POST /v1/public/care-offers/{token}/cancel-assignment",
    "POST /v1/public/visit-confirmations/{token}/open",
    "POST /v1/public/visit-confirmations/{token}/respond",
])

RESULTS = []


def check(area, name, ok, detail=""):
    RESULTS.append((area, name, bool(ok), detail))
    print("  %s  %-14s %s%s" % ("PASS" if ok else "FAIL", area, name, (" (" + detail + ")") if detail and not ok else ""), flush=True)
    return bool(ok)


def guarded(area, name, fn):
    try:
        return fn()
    except Exception as exc:  # report and continue: every check is listed
        check(area, name, False, "%s: %s" % (type(exc).__name__, str(exc)[:200]))
        return None


# ---------------------------------------------------------------- helpers
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_noredirect(url):
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(url, timeout=20) as r:
            return r.status, dict((k.lower(), v) for k, v in r.headers.items())
    except urllib.error.HTTPError as e:
        return e.code, dict((k.lower(), v) for k, v in e.headers.items())


def png(width=48, height=24, seed=0):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(((x * 7 + y * 13 + seed) & 0xFF) for x in range(width)) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class Invoker:
    def __init__(self, args, client_id):
        self.args = args
        self.client_id = client_id
        self.function = None
        if args.mode == "aws":
            res = aws("cloudformation", "describe-stack-resources", "--stack-name", "Ogevia-prod-ServiceVerificationApi")
            fns = [r["PhysicalResourceId"] for r in res["StackResources"] if r["ResourceType"] == "AWS::Lambda::Function"]
            self.function = fns[0]

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


def wait_minutes(args, visit_id, minutes):
    if args.mode == "local":
        subprocess.run(args.age_cmd + " %s %d" % (visit_id, minutes), shell=True, check=True, capture_output=True)
        return
    seconds = minutes * 60 + 8
    print("  ....  waiting %ds so the visit has %d worked minute(s) (server time is authoritative)" % (seconds, minutes), flush=True)
    end = time.time() + seconds
    while time.time() < end:
        time.sleep(min(15, max(0, end - time.time())))
        print("  ....  %ds left" % max(0, int(end - time.time())), flush=True)


# ---------------------------------------------------------------- workflow
def workflow(args, inv, cg, mg):
    A = "workflow"
    s, me = inv.call("GET /v1/me", cg)
    orgs = [m for m in (me or {}).get("memberships", []) if m.get("organizationSlug") == TEST_ORG_SLUG]
    if not check(A, "DB reachable; caregiver seeded in the test agency (GET /v1/me)", s == 200 and len(orgs) == 1 and orgs[0]["role"] == "caregiver", "status %s" % s):
        check(A, "seed present", False, "ogevia_sv_test seed missing for the caregiver sub: re-run the approved database window")
        return
    org = orgs[0]["organizationId"]
    s, me_m = inv.call("GET /v1/me", mg)
    mm = [m for m in (me_m or {}).get("memberships", []) if m.get("organizationId") == org]
    check(A, "manager seeded with visits.read + billing.visits.read", s == 200 and mm and mm[0]["role"] == "manager"
          and {"visits.read", "visits.manage", "billing.visits.read"} <= set(mm[0]["permissions"]))

    # Idempotent re-runs: close any visit a previous interrupted run left open.
    s, act = inv.call("GET /v1/visits/active", cg, query={"organizationId": org})
    if s == 200 and act.get("visit"):
        v = act["visit"]
        print("  ....  closing a visit left open by an earlier run", flush=True)
        if v["visitStatus"] == "draft":
            age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(v["timeIn"].replace("Z", "+00:00"))).total_seconds()
            if age < 70:
                wait_minutes(args, v["visitId"], 1)
            inv.call("POST /v1/visits/{visitId}/end", cg, path={"visitId": v["visitId"]})
        inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": v["visitId"]},
                 body={"signerRole": "client", "method": "unable_to_confirm", "reason": "Automated smoke test cleanup (synthetic)"})

    s, cl = inv.call("GET /v1/clients/assigned", cg, query={"organizationId": org})
    codes = {c["clientCode"]: c["clientId"] for c in (cl or {}).get("clients", [])}
    check(A, "assigned clients = TEST-C01, TEST-C02 (codes only, no names)", s == 200 and {"TEST-C01", "TEST-C02"} <= set(codes)
          and all(set(c) == {"clientId", "clientCode", "nextScheduledStartsAt", "nextScheduledEndsAt", "activeServiceCount",
                         "nextScheduledServiceId"} for c in cl["clients"]))
    if "TEST-C01" not in codes or "TEST-C02" not in codes:
        return
    c1, c2 = codes["TEST-C01"], codes["TEST-C02"]
    s, sv = inv.call("GET /v1/clients/{clientId}/services", cg, path={"clientId": c1}, query={"organizationId": org})
    svc = (sv or {}).get("services", [])
    check(A, "authorized service for TEST-C01 (RSP, 600 min/month)", s == 200 and len(svc) >= 1 and svc[0]["serviceCode"] == "RSP" and svc[0]["monthlyAuthorizedMinutes"] == 600)
    if not svc:
        return
    service = svc[0]["serviceId"]

    # Wave 1 (0050): the seeded identities have no scheduled shift, so every visit here is an UNSCHEDULED (provisional)
    # visit. The database refuses it without a reason, and it ends in administrator review (never Billing Ready).
    reason = "Automated smoke test: no shift scheduled (synthetic)"
    s0, _ = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c1, "serviceId": service})
    check(A, "start without a scheduled shift and without a reason is refused (422)", s0 == 422, "status %s" % s0)
    k1 = str(uuid.uuid4())
    s, st = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c1, "serviceId": service, "unscheduledReason": reason,
                                                   "timeIn": "2000-01-01T00:00:00Z"}, key=k1)
    v1 = (st or {}).get("visitId")
    check(A, "start unscheduled visit with a reason (server time; client time ignored)", s == 201 and v1)
    s2, st2 = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c1, "serviceId": service, "unscheduledReason": reason}, key=k1)
    check(A, "start retry with the same Idempotency-Key returns the same visit", s2 == 201 and (st2 or {}).get("visitId") == v1)
    s3, _ = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c1, "serviceId": service, "unscheduledReason": reason})
    check(A, "second open visit refused (409)", s3 == 409)
    s, act = inv.call("GET /v1/visits/active", cg, query={"organizationId": org})
    check(A, "active visit = draft, server timestamp near now", s == 200 and act["visit"]["visitId"] == v1 and act["visit"]["visitStatus"] == "draft"
          and abs(time.time() - datetime.datetime.fromisoformat(act["visit"]["timeIn"].replace("Z", "+00:00")).timestamp()) < 600)

    wait_minutes(args, v1, 2)
    s, en = inv.call("POST /v1/visits/{visitId}/end", cg, path={"visitId": v1})
    check(A, "end visit (server time; worked >= 2 min)", s == 200 and en["visit"]["workedMinutes"] >= 2)

    sig = png(seed=int(time.time()) % 200)
    sig_b64 = base64.b64encode(sig).decode()
    kc = str(uuid.uuid4())
    body = {"organizationId": org, "signerRole": "parent", "method": "draw", "signaturePng": sig_b64, "attested": True}
    s, cf = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": v1}, body=body, key=kc)
    res = (cf or {}).get("result") or {}
    out = res.get("outcome") or {}
    check(A, "signature confirmation of an unscheduled visit locks it and routes it to administrator review (not Billing Ready)",
          s == 200 and res.get("status") == "administrator_review", "status %s %s" % (s, res.get("status")))
    check(A, "review reason 'unscheduled' and the stored reason are returned",
          "unscheduled" in (out.get("reviewReasons") or []) and out.get("unscheduledReason") == reason,
          json.dumps({k: out.get(k) for k in ("reviewReasons", "unscheduledReason")})[:160])
    check(A, "the server names the attestation version (attest-v1); the client cannot", out.get("attestationVersion") == "attest-v1", str(out.get("attestationVersion")))
    s, cf2 = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": v1}, body=body, key=kc)
    check(A, "confirm retry (same key) returns the stored result", s == 200 and (cf2 or {}).get("result") == (cf or {}).get("result"))
    s, _ = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": v1}, body=body)
    check(A, "locked visit cannot be confirmed again (409)", s == 409)

    if args.mode == "aws":
        key = "%s/%s/client-signature.png" % (org, v1)
        head = guarded("evidence", "signature object stored", lambda: aws("s3api", "head-object", "--bucket", EVIDENCE_BUCKET, "--key", key))
        if head is not None:
            check("evidence", "object encrypted with SSE-KMS (evidence key)", head.get("ServerSideEncryption") == "aws:kms" and "alias" not in head.get("SSEKMSKeyId", "alias"))
            check("evidence", "object versioned (pinned VersionId)", bool(head.get("VersionId")))
            check("evidence", "object path holds UUIDs only (no PHI)", key.count("/") == 2 and key.endswith("/client-signature.png"))
        code, _, _ = http("https://%s.s3.%s.amazonaws.com/%s" % (EVIDENCE_BUCKET, REGION, key))
        check("evidence", "anonymous object GET denied (403)", code == 403, "got %s" % code)

    s, lst = inv.call("GET /v1/visits", mg, query={"organizationId": org})
    by_id = dict((v["id"], v) for v in (lst or {}).get("visits", []))
    check(A, "manager visit records include the unscheduled visit, in administrator review", s == 200 and by_id.get(v1, {}).get("status") == "administrator_review")
    visit_ref = by_id.get(v1, {}).get("visitNumber", "")
    check(A, "new visit reference is tenant-neutral CLIENT-SERVICE-DDMMYY-HHMM-XX",
          bool(re.match(r"^[A-Z0-9]+-[A-Z0-9]+-[0-9]{6}-[0-9]{4}-[0-9A-F]{2}$", visit_ref)),
          visit_ref)
    s, sg = inv.call("GET /v1/visits/{visitId}/signature", mg, path={"visitId": v1})
    check(A, "manager views signature (bytes identical; integrity-checked)", s == 200 and sg["pngBase64"] == sig_b64)
    s, _ = inv.call("GET /v1/visits/{visitId}/signature", cg, path={"visitId": v1})
    check(A, "caregiver cannot read signatures (403)", s == 403)
    orig = by_id.get(v1, {})
    if orig:
        new_in = (datetime.datetime.fromisoformat(orig["timeIn"].replace("Z", "+00:00")) + datetime.timedelta(seconds=30)).isoformat()
        s, cr = inv.call("POST /v1/visits/{visitId}/corrections", mg, path={"visitId": v1},
                         body={"timeIn": new_in, "timeOut": orig["timeOut"], "reason": "Automated smoke test correction (synthetic)"})
        check(A, "manager correction creates a corrected row", s == 201 and (cr or {}).get("correctedVisitId"), "status %s %s" % (s, json.dumps(cr)[:120]))
        s, hist = inv.call("GET /v1/visits/{visitId}/corrections", mg, path={"visitId": v1})
        h = (hist or {}).get("corrections", [])
        check(A, "correction history keeps before/after, reason, actor", s == 200 and len(h) == 1 and h[0]["beforeSnapshot"] and h[0]["afterSnapshot"] and h[0]["reason"])
        s, _ = inv.call("POST /v1/visits/{visitId}/corrections", cg, path={"visitId": v1},
                        body={"timeIn": new_in, "timeOut": orig["timeOut"], "reason": "should fail"})
        check(A, "caregiver cannot correct (403/409)", s in (403, 409))


    k2 = str(uuid.uuid4())
    s, st = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c2, "serviceId": service, "unscheduledReason": reason}, key=k2)
    v2 = (st or {}).get("visitId")
    check(A, "start second visit (TEST-C02)", s == 201 and v2)
    wait_minutes(args, v2, 1)
    inv.call("POST /v1/visits/{visitId}/end", cg, path={"visitId": v2})
    s, ns = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": v2},
                     body={"signerRole": "client", "method": "unable_to_confirm", "reason": "Technical problem prevented signing (automated smoke, synthetic)"})
    check(A, "no-signature path -> administrator_review, 0 billable", s == 200 and ns["result"]["status"] == "administrator_review" and ns["result"]["billableMinutes"] == 0)

    s, lst = inv.call("GET /v1/visits", mg, query={"organizationId": org})
    statuses = dict((v["id"], v["status"]) for v in (lst or {}).get("visits", []))
    check(A, "manager visit records: original kept as corrected, no-signature visit in review", s == 200 and statuses.get(v1) == "corrected" and statuses.get(v2) == "administrator_review")

    today = datetime.date.today()
    month_start = today.replace(day=1)

    s, ms = inv.call("GET /v1/reports/monthly-service-summary", mg,
                     query={"organizationId": org, "clientId": c1, "monthStart": str(month_start)})
    service_rows = (ms or {}).get("services", [])
    check(A, "monthly service summary returns a separate RSP authorization row",
          s == 200 and any(r["clientId"] == c1 and r["serviceId"] == service
                           and r["serviceCode"] == "RSP"
                           and r["authorizedMinutes"] == 600
                           and r["workedMinutes"] >= 1 for r in service_rows),
          "status %s rows %d" % (s, len(service_rows)))
    s, ms_cg = inv.call("GET /v1/reports/monthly-service-summary", cg,
                        query={"organizationId": org, "clientId": c1, "monthStart": str(month_start)})
    check(A, "caregiver gets no manager monthly-summary data",
          s == 200 and (ms_cg or {}).get("services", []) == [])

    s, ch = inv.call("GET /v1/reports/correction-history", mg,
                     query={"organizationId": org,
                            "dateFrom": str(today - datetime.timedelta(days=2)),
                            "dateTo": str(today + datetime.timedelta(days=1)),
                            "clientId": c1,
                            "caregiverUserId": orig.get("caregiverUserId")})
    correction_rows = (ch or {}).get("corrections", [])
    check(A, "correction-history report exposes immutable before/after audit data",
          s == 200 and any(r["visitNumber"] == visit_ref
                           and r["beforeSnapshot"] and r["afterSnapshot"]
                           and r["caregiverUserId"]
                           and r["correctedByUserId"]
                           and r["correctedVisitStatus"] in ("signed", "administrator_review")
                           for r in correction_rows),
          "status %s rows %d" % (s, len(correction_rows)))
    s, ch_cg = inv.call("GET /v1/reports/correction-history", cg,
                        query={"organizationId": org,
                               "dateFrom": str(today - datetime.timedelta(days=2)),
                               "dateTo": str(today + datetime.timedelta(days=1))})
    check(A, "caregiver gets no organization correction-history data",
          s == 200 and (ch_cg or {}).get("corrections", []) == [])

    s, br = inv.call("GET /v1/billing-review", mg, query={"organizationId": org, "dateFrom": str(today - datetime.timedelta(days=2)), "dateTo": str(today + datetime.timedelta(days=1))})
    rows = (br or {}).get("visits", [])
    check(A, "billing review: corrected signed visit = ready", s == 200 and any(r["isCorrection"] and r["reviewState"] == "ready" for r in rows))
    check(A, "billing review: no-signature visit = needs review", any(r["visitId"] == v2 and r["reviewState"] != "ready" for r in rows))
    s, brc = inv.call("GET /v1/billing-review", cg, query={"organizationId": org, "dateFrom": str(today - datetime.timedelta(days=2)), "dateTo": str(today + datetime.timedelta(days=1))})
    check(A, "caregiver gets no billing data", s == 200 and brc["visits"] == [])

    T = "tenant"
    s, other = inv.call("GET /v1/visits", mg, query={"organizationId": str(uuid.uuid4())})
    check(T, "other/unknown organization returns nothing", s in (403, 404) or (s == 200 and other["visits"] == []))
    forged = inv.claims(cg, {"cognito:groups": ["organization_owner"], "custom:role": "manager", "custom:organization_id": org})
    s, fb = inv.call("GET /v1/billing-review", None, claims=forged, query={"organizationId": org, "dateFrom": "2000-01-01", "dateTo": "2100-01-01"})
    check(T, "forged role/group/org claims grant nothing", s == 200 and fb["visits"] == [])
    s, _ = inv.call("GET /v1/me", str(uuid.uuid4()))
    check(T, "unknown Cognito sub is rejected (401)", s == 401)
    s, _ = inv.call("GET /v1/me", None)
    check(T, "request without authorizer claims is rejected (401)", s == 401)
    s, _ = inv.call("GET /v1/me", None, claims=inv.claims(cg, {"client_id": "someotherclient00000000000"}))
    check(T, "token for an unapproved app client is rejected (401)", s == 401)
    s, _ = inv.call("GET /v1/me", None, claims=inv.claims(cg, {"token_use": "id"}))
    check(T, "ID token is rejected (401)", s == 401)
    return {"sensitive": [cg, mg, org, v1, v2, sig_b64[:40], "Technical problem prevented"]}


# ---------------------------------------------------------------- care requests
def scheduled_workflow(args, inv, cg, mg):
    """A correctly scheduled visit end to end: the clean path that Billing Ready is for (SMK-07).

    Complements `workflow`, whose seeded caregiver has no shift (those visits are unscheduled and go to review).
    Creates ONE short synthetic shift for TEST-CG-01 on TEST-C01 (the smallest the system allows, 15 minutes), starts
    the visit on it, ends it after a few minutes, and confirms it with a drawn signature. Expected: signed, billable
    equal to worked, no review reason, the shift's reservation becomes used time once, authorization left unchanged.
    """
    A = "scheduled"
    s, me = inv.call("GET /v1/me", cg)
    orgs = [m for m in (me or {}).get("memberships", []) if m.get("organizationSlug") == TEST_ORG_SLUG]
    if not check(A, "caregiver seeded in the test agency", s == 200 and len(orgs) == 1, "status %s" % s):
        return
    org = orgs[0]["organizationId"]
    tz = zoneinfo.ZoneInfo(orgs[0].get("organizationTimezone") or "America/Los_Angeles")
    s, cl = inv.call("GET /v1/clients/assigned", cg, query={"organizationId": org})
    c1 = next((c["clientId"] for c in (cl or {}).get("clients", []) if c["clientCode"] == "TEST-C01"), None)
    s, sv = inv.call("GET /v1/clients/{clientId}/services", cg, path={"clientId": c1}, query={"organizationId": org}) if c1 else (0, None)
    svc = (sv or {}).get("services", [])
    if not check(A, "TEST-C01 and its authorized service are assigned to the caregiver", c1 and svc):
        return
    service = svc[0]["serviceId"]
    s, cgs = inv.call("GET /v1/caregivers", mg, query={"organizationId": org})
    rec = next((c["caregiverRecordId"] for c in (cgs or {}).get("caregivers", []) if c.get("caregiverCode") == "TEST-CG-01"), None)
    if not check(A, "manager finds the TEST-CG-01 Care Team record", rec, "status %s" % s):
        return

    month_start = datetime.date.today().replace(day=1)

    def position():
        _, ms = inv.call("GET /v1/reports/monthly-service-summary", mg, query={"organizationId": org, "clientId": c1, "monthStart": str(month_start)})
        return next((r for r in (ms or {}).get("services", []) if r["clientId"] == c1 and r["serviceId"] == service), {})

    # Close anything left open by an interrupted earlier run (same idea as `workflow`).
    s, act = inv.call("GET /v1/visits/active", cg, query={"organizationId": org})
    if s == 200 and act.get("visit"):
        check(A, "a visit left open by an earlier run is present", False, "finish or confirm it, then run again")
        return

    before = position()
    local_now = datetime.datetime.now(tz)
    # A shift from an earlier run keeps its time slot, so a second run within the hour tries later start times. Starts up to
    # 60 minutes ahead still match at Time In (early-arrival window).
    for offset in (1, 20, 40):
        start = local_now + datetime.timedelta(minutes=offset)
        end = start + datetime.timedelta(minutes=15)
        s, sh = inv.call("POST /v1/shifts", mg, body={"organizationId": org, "clientId": c1, "serviceId": service, "date": start.date().isoformat(),
                                                      "startTime": start.strftime("%H:%M"), "endTime": end.strftime("%H:%M"), "caregiverRecordId": rec})
        if s != 409:
            break
    shift = (sh or {}).get("shift", {})
    if not check(A, "manager schedules a 15-minute shift for the caregiver (reserves authorized time)",
                 s == 201 and shift.get("shiftId") and shift.get("reservedMinutes") == 15, "status %s %s" % (s, json.dumps(sh)[:160])):
        return
    mid = position()
    check(A, "the reservation shows in the monthly summary (reserved +15)",
          mid.get("reservedMinutes", 0) - before.get("reservedMinutes", 0) == 15, "%s -> %s" % (before.get("reservedMinutes"), mid.get("reservedMinutes")))

    k = str(uuid.uuid4())
    s, st = inv.call("POST /v1/visits", cg, body={"organizationId": org, "clientId": c1, "serviceId": service}, key=k)
    visit = (st or {}).get("visitId")
    check(A, "start on the scheduled shift needs no reason (201)", s == 201 and visit, "status %s %s" % (s, json.dumps(st)[:120]))
    if not visit:
        return
    wait_minutes(args, visit, 3)
    s, en = inv.call("POST /v1/visits/{visitId}/end", cg, path={"visitId": visit})
    worked = (en or {}).get("visit", {}).get("workedMinutes", 0)
    check(A, "end visit (server time; worked 3 minutes or more)", s == 200 and worked >= 3, "status %s worked %s" % (s, worked))
    body = {"organizationId": org, "signerRole": "parent", "method": "draw", "signaturePng": base64.b64encode(png(seed=int(time.time()) % 200)).decode(), "attested": True}
    s, cf = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": visit}, body=body, key=str(uuid.uuid4()))
    res = (cf or {}).get("result") or {}
    out = res.get("outcome") or {}
    check(A, "client signature -> signed (Billing Ready), billable equals worked, no review reason",
          s == 200 and res.get("status") == "signed" and res.get("billableMinutes") == res.get("workedMinutes") == worked and out.get("reviewReasons") == [],
          "status %s %s" % (s, json.dumps({"status": res.get("status"), "billable": res.get("billableMinutes"), "worked": res.get("workedMinutes"), "reasons": out.get("reviewReasons")})))
    check(A, "attestation recorded by the server (attest-v1); no unscheduled reason", out.get("attestationVersion") == "attest-v1" and out.get("unscheduledReason") is None)
    after = position()
    check(A, "reservation released and the worked minutes used once (reserved back, billable +worked)",
          after.get("reservedMinutes", 0) == before.get("reservedMinutes", 0)
          and after.get("billableMinutes", 0) - before.get("billableMinutes", 0) == worked,
          "before %s after %s" % ({k2: before.get(k2) for k2 in ("billableMinutes", "reservedMinutes")}, {k2: after.get(k2) for k2 in ("billableMinutes", "reservedMinutes")}))
    check(A, "authorization left reduced by exactly the worked minutes (not by the shift as well)",
          before.get("remainingMinutes", 0) - after.get("remainingMinutes", 0) == worked,
          "before %s after %s" % (before.get("remainingMinutes"), after.get("remainingMinutes")))
    s, lst = inv.call("GET /v1/visits", mg, query={"organizationId": org})
    row = next((v for v in (lst or {}).get("visits", []) if v["id"] == visit), {})
    check(A, "manager list shows the visit signed", row.get("status") == "signed", str(row.get("status")))
    s, br = inv.call("GET /v1/billing-review", mg, query={"organizationId": org, "dateFrom": str(month_start), "dateTo": str(datetime.date.today() + datetime.timedelta(days=1))})
    brow = next((v for v in (br or {}).get("visits", []) if (v.get("visitId") or v.get("id")) == visit), {})
    check(A, "billing review lists it as ready", s == 200 and brow.get("reviewState") == "ready", "status %s state %s" % (s, brow.get("reviewState")))
    s2, again = inv.call("POST /v1/visits/{visitId}/confirm", cg, path={"visitId": visit}, body=body, key=str(uuid.uuid4()))
    check(A, "a second confirmation with a new key is refused (409); the visit stays locked", s2 == 409, "status %s" % s2)


def care_workflow(args, inv, cg, mg):
    """Client link -> availability -> offer -> Available (no auto-assign) -> agency
    assignment (one reservation) -> caregiver call-out (same shift, Coverage Needed)
    -> client cancellation -> link revocation. SYNTHETIC TEST data only."""
    C = "care"
    s, me = inv.call("GET /v1/me", mg)
    orgs = [m for m in (me or {}).get("memberships", []) if m.get("organizationSlug") == TEST_ORG_SLUG]
    if not check(C, "manager has care_requests.manage in the test agency", s == 200 and orgs and "care_requests.manage" in orgs[0]["permissions"]):
        return
    org = orgs[0]["organizationId"]
    s, cl = inv.call("GET /v1/care-portals/clients", mg, query={"organizationId": org})
    clients = dict((c["clientCode"], c["clientId"]) for c in (cl or {}).get("clients", []))
    if not check(C, "TEST-C01 available for a client link", "TEST-C01" in clients):
        return
    s, pr = inv.call("POST /v1/care-portals", mg, body={"organizationId": org, "clientId": clients["TEST-C01"], "label": "smoke (synthetic)"})
    token = (pr or {}).get("portal", {}).get("token", "")
    check(C, "agency creates a reusable client link (256-bit token returned once)", s == 201 and len(token) == 64)
    s, portal = inv.call("GET /v1/public/care-portals/{token}", None, path={"token": token})
    services = (portal or {}).get("services", [])
    check(C, "client link shows only that client's authorized services", s == 200 and services and all(x["clientCode"] == "TEST-C01" for x in services))
    if not services:
        return
    service = services[0]["serviceId"]
    start = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=5)).replace(hour=18, minute=0, second=0, microsecond=0)
    s, short = inv.call("POST /v1/public/care-portals/{token}/requests", None, path={"token": token},
                        body={"serviceId": service, "startsAt": start.isoformat(), "endsAt": (start + datetime.timedelta(hours=2)).isoformat(), "requestKey": str(uuid.uuid4())})
    check(C, "requests under 3 hours are refused (422)", s == 422)
    key = str(uuid.uuid4())
    body = {"serviceId": service, "startsAt": start.isoformat(), "endsAt": (start + datetime.timedelta(hours=4)).isoformat(), "requestKey": key, "note": "smoke (synthetic)"}
    s, rq = inv.call("POST /v1/public/care-portals/{token}/requests", None, path={"token": token}, body=body)
    req = (rq or {}).get("request", {})
    check(C, "client submits a request through the link (not short notice)", s == 201 and req.get("status") == "requested" and req.get("shortNotice") is False)
    s, again = inv.call("POST /v1/public/care-portals/{token}/requests", None, path={"token": token}, body=body)
    check(C, "re-submitting the same request is idempotent", s == 201 and (again or {}).get("request", {}).get("requestId") == req.get("requestId"))
    rid = req.get("requestId")
    if not rid:
        return
    s, mine = inv.call("GET /v1/public/care-portals/{token}/requests", None, path={"token": token})
    check(C, "reopened client link lists its own request (status visible without the request id)",
          s == 200 and [r["requestId"] for r in (mine or {}).get("requests", [])] == [rid] and mine["requests"][0]["status"] == "requested")
    # Availability needs administrator approval (0039). The caregiver cannot write it directly, can only request a change,
    # and the seeded manager (no availability.review) cannot approve it. The candidate below comes from the seeded
    # availability (db/deploy/03_seed_care_acceptance.sql: TEST-CG-02), not from anything this script writes.
    allweek = [{"weekday": d, "specific_date": None, "start_local": "00:00", "end_local": "23:59"} for d in range(7)]
    s, direct = inv.call("POST /v1/availability/me", cg, body={"organizationId": org, "windows": allweek, "unavailableDates": []})
    check(C, "caregiver cannot write availability directly (422 availability_requires_approval)",
          s == 422 and ((direct or {}).get("error") or {}).get("code") == "availability_requires_approval", "status %s" % s)
    s, areq = inv.call("POST /v1/availability/requests", cg, body={"organizationId": org, "kind": "weekly", "windows": allweek,
                       "effectiveFrom": datetime.date.today().isoformat(), "reason": "Automated smoke test (synthetic)", "baseVersion": 0})
    arid = (areq or {}).get("requestId")
    check(C, "caregiver can request an availability change (pending, 201)", s == 201 and arid, "status %s" % s)
    if arid:
        s, _ = inv.call("POST /v1/availability/requests/{requestId}/review", mg, path={"requestId": arid},
                        body={"organizationId": org, "decision": "approve"})
        check(C, "a manager without availability.review cannot approve it (403)", s == 403, "status %s" % s)
        s, _ = inv.call("POST /v1/availability/requests/{requestId}/withdraw", cg, path={"requestId": arid}, body={"organizationId": org})
        check(C, "caregiver withdraws the smoke request (nothing left pending)", s == 200, "status %s" % s)
    s, cand = inv.call("GET /v1/care-requests/{requestId}/candidates", mg, path={"requestId": rid}, query={"organizationId": org})
    cands = (cand or {}).get("caregivers", [])
    check(C, "available caregiver is a candidate", s == 200 and len(cands) >= 1,
          "none: apply db/deploy/03_seed_care_acceptance.sql (seeded availability) to this database" if s == 200 else "status %s" % s)
    if not cands:
        return
    cr = cands[0]["caregiverRecordId"]
    s, of = inv.call("POST /v1/care-requests/{requestId}/offers", mg, path={"requestId": rid}, body={"organizationId": org, "caregiverRecordId": cr})
    offer = (of or {}).get("offer", {})
    check(C, "agency sends an offer link", s == 201 and len(offer.get("token", "")) == 64)
    s, rs = inv.call("POST /v1/public/care-offers/{token}/respond", None, path={"token": offer.get("token")}, body={"available": True})
    check(C, "caregiver answers Available through the link", s == 200 and (rs or {}).get("status") == "available")
    s, lst = inv.call("GET /v1/care-requests", mg, query={"organizationId": org})
    row = next((r for r in (lst or {}).get("requests", []) if r["requestId"] == rid), {})
    check(C, "Available does NOT assign (pending agency decision)", row.get("status") == "accepted_pending_assignment" and not row.get("assignedCaregiverName"))
    s, _ = inv.call("POST /v1/care-requests/{requestId}/assign", cg, path={"requestId": rid}, body={"organizationId": org, "offerId": offer.get("offerId")})
    check(C, "a caregiver cannot assign (403)", s == 403)
    s, asg = inv.call("POST /v1/care-requests/{requestId}/assign", mg, path={"requestId": rid}, body={"organizationId": org, "offerId": offer.get("offerId")})
    if s == 409 and "authorized time" in ((asg or {}).get("error") or {}).get("message", ""):
        # The month is already reserved by other TEST activity (e.g. owner browser testing).
        # That refusal IS the authorization cap working; staff the same flow in the next
        # authorized month instead of touching anyone else's synthetic requests.
        check(C, "authorization cap enforced: assignment beyond the month's remaining authorized time is refused (409)", True,
              "this month is already reserved by other TEST activity")
        inv.call("POST /v1/public/care-portals/{token}/requests/{requestId}/cancel", None, path={"token": token, "requestId": rid}, body={"reason": "smoke (synthetic) - month full"})
        now = datetime.datetime.now(datetime.timezone.utc)
        nxt = (now.replace(day=1) + datetime.timedelta(days=32)).replace(day=5, hour=18, minute=0, second=0, microsecond=0)
        s, rq = inv.call("POST /v1/public/care-portals/{token}/requests", None, path={"token": token},
                         body={"serviceId": service, "startsAt": nxt.isoformat(), "endsAt": (nxt + datetime.timedelta(hours=4)).isoformat(), "requestKey": str(uuid.uuid4()), "note": "smoke (synthetic)"})
        rid = (rq or {}).get("request", {}).get("requestId")
        s, cand = inv.call("GET /v1/care-requests/{requestId}/candidates", mg, path={"requestId": rid}, query={"organizationId": org})
        cands = (cand or {}).get("caregivers", [])
        cr = cands[0]["caregiverRecordId"] if cands else cr
        s, of = inv.call("POST /v1/care-requests/{requestId}/offers", mg, path={"requestId": rid}, body={"organizationId": org, "caregiverRecordId": cr})
        offer = (of or {}).get("offer", {})
        inv.call("POST /v1/public/care-offers/{token}/respond", None, path={"token": offer.get("token")}, body={"available": True})
        s, asg = inv.call("POST /v1/care-requests/{requestId}/assign", mg, path={"requestId": rid}, body={"organizationId": org, "offerId": offer.get("offerId")})
    shift = (asg or {}).get("shiftId")
    check(C, "agency assigns: one shift created", s == 200 and shift)
    s, view = inv.call("GET /v1/public/care-portals/{token}/requests/{requestId}", None, path={"token": token, "requestId": rid})
    check(C, "client sees Assigned through the link", s == 200 and view["request"]["status"] == "assigned")
    s, co = inv.call("POST /v1/public/care-offers/{token}/cancel-assignment", None, path={"token": offer.get("token")}, body={"reason": "smoke call-out (synthetic)"})
    check(C, "caregiver call-out returns the request to Coverage Needed", s == 200 and (co or {}).get("status") == "coverage_needed")
    s, lst = inv.call("GET /v1/care-requests", mg, query={"organizationId": org})
    row = next((r for r in (lst or {}).get("requests", []) if r["requestId"] == rid), {})
    check(C, "staff queue shows Coverage Needed", row.get("status") == "coverage_needed")
    s, cc = inv.call("POST /v1/public/care-portals/{token}/requests/{requestId}/cancel", None, path={"token": token, "requestId": rid}, body={"reason": "smoke (synthetic)"})
    check(C, "client cancels through the link", s == 200 and (cc or {}).get("status") == "client_cancelled")
    s, mine = inv.call("GET /v1/public/care-portals/{token}/requests", None, path={"token": token})
    check(C, "client link list shows the cancellation", s == 200 and any(r["requestId"] == rid and r["status"] == "client_cancelled" for r in (mine or {}).get("requests", [])))
    s, _ = inv.call("GET /v1/public/care-offers/{token}", None, path={"token": offer.get("token")})
    check(C, "offer link stops working after client cancellation (404)", s == 404)
    s, rv = inv.call("POST /v1/care-portals/revoke", mg, body={"organizationId": org, "clientId": clients["TEST-C01"]})
    check(C, "agency revokes the client's links", s == 200 and (rv or {}).get("revoked", 0) >= 1)
    s, _ = inv.call("GET /v1/public/care-portals/{token}", None, path={"token": token})
    check(C, "revoked client link -> 404", s == 404)
    s, _ = inv.call("GET /v1/public/care-portals/{token}/requests", None, path={"token": token})
    check(C, "revoked client link cannot list requests (404)", s == 404)
    return [token, offer.get("token", "")]


# ---------------------------------------------------------------- infra (aws mode)
def infra(args, out):
    web, api_url, client_id = out["WebOrigin"], out["ApiUrl"], out["TestAppClientId"]

    C = "cognito"
    def cognito():
        c = aws("cognito-idp", "describe-user-pool-client", "--user-pool-id", POOL, "--client-id", client_id)["UserPoolClient"]
        check(C, "test app client is public (no secret)", "ClientSecret" not in c)
        check(C, "code flow only; scopes openid+email", c.get("AllowedOAuthFlows") == ["code"] and set(c.get("AllowedOAuthScopes", [])) == {"openid", "email"})
        check(C, "callback = <web>/auth/callback", c.get("CallbackURLs") == [web + "/auth/callback"], str(c.get("CallbackURLs")))
        check(C, "logout = <web>/", c.get("LogoutURLs") == [web + "/"])
        check(C, "no plaintext password flows", not any("PASSWORD" in f and "SRP" not in f for f in c.get("ExplicitAuthFlows", [])))
        pool = aws("cognito-idp", "describe-user-pool", "--user-pool-id", POOL)["UserPool"]
        check(C, "existing pool unchanged: MFA ON, admin-create-only", pool.get("MfaConfiguration") == "ON" and pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"])
        clients = aws("cognito-idp", "list-user-pool-clients", "--user-pool-id", POOL, "--max-results", "20")["UserPoolClients"]
        check(C, "existing ogevia-web client still present", any(x["ClientId"] == EXISTING_CLIENT for x in clients))
    guarded(C, "cognito checks", cognito)

    G = "api"
    def api():
        api_id = api_url.split("//")[1].split(".")[0]
        auths = aws("apigatewayv2", "get-authorizers", "--api-id", api_id)["Items"]
        jwt = auths[0]["JwtConfiguration"]
        check(G, "JWT authorizer: issuer = existing pool", jwt["Issuer"] == "https://cognito-idp.%s.amazonaws.com/%s" % (REGION, POOL))
        check(G, "JWT audience = ogevia-web + test client only", sorted(jwt["Audience"]) == sorted([EXISTING_CLIENT, client_id]))
        routes = aws("apigatewayv2", "get-routes", "--api-id", api_id)["Items"]
        public_care = [r for r in routes if r.get("AuthorizationType") != "JWT"]
        staff_routes = [r for r in routes if r.get("AuthorizationType") == "JWT"]
        check(G, "%d routes; only the exact approved token-link routes are public" % EXPECTED_ROUTES, len(routes) == EXPECTED_ROUTES
              and sorted(r["RouteKey"] for r in public_care) == APPROVED_PUBLIC_ROUTE_KEYS
              and all(r.get("AuthorizationType") == "NONE" and not r.get("AuthorizerId") for r in public_care)
              and all(r.get("AuthorizationType") == "JWT" and r.get("AuthorizerId") for r in staff_routes)
              and not any(r["RouteKey"] == "$default" or r["RouteKey"].startswith("ANY ") for r in routes))
        code, _, _ = http(api_url + "/v1/me")
        check(G, "anonymous GET /v1/me -> 401", code == 401, "got %s" % code)
        rnd = os.urandom(32).hex()
        code, _, body = http(api_url + "/v1/public/care-portals/" + rnd)
        check(G, "public portal link with an unknown token -> 404 (generic)", code == 404 and b"not valid or is no longer active" in body, "got %s" % code)
        code, _, body = http(api_url + "/v1/public/care-portals/" + rnd + "/requests")
        check(G, "request list with an unknown token -> 404 (never an empty list)", code == 404 and b"not valid or is no longer active" in body, "got %s" % code)
        code, _, _ = http(api_url + "/v1/public/care-offers/" + rnd)
        check(G, "public offer link with an unknown token -> 404", code == 404, "got %s" % code)
        code, _, _ = http(api_url + "/v1/public/care-offers/" + rnd + "/respond", method="POST", headers={"content-type": "application/json"}, body=b'{"available":true}')
        check(G, "public offer response with an unknown token -> 404", code == 404, "got %s" % code)
        code, _, _ = http(api_url + "/v1/public/care-portals/not-a-token")
        check(G, "public link with a malformed token -> 400", code == 400, "got %s" % code)
        for key in ("/v1/care-requests", "/v1/care-portals/clients", "/v1/availability/me"):
            code, _, _ = http(api_url + key + "?organizationId=" + str(uuid.uuid4()))
            check(G, "anonymous staff/caregiver care route %s -> 401" % key, code == 401, "got %s" % code)
        code, _, _ = http(api_url + "/v1/clients/assigned?organizationId=" + str(uuid.uuid4()))
        check(G, "anonymous data route -> 401", code == 401, "got %s" % code)
        fake = "eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ." + base64.urlsafe_b64encode(json.dumps({"sub": str(uuid.uuid4()), "token_use": "access", "client_id": client_id}).encode()).decode().rstrip("=") + ".c2ln"
        code, _, _ = http(api_url + "/v1/me", headers={"Authorization": "Bearer " + fake})
        check(G, "forged bearer token -> 401", code == 401, "got %s" % code)
        code, _, _ = http(api_url + "/v1/me", method="OPTIONS", headers={"Origin": web, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
        check(G, "CORS preflight allowed for the web origin", code in (200, 204), "got %s" % code)
        code, hdrs, _ = http(api_url + "/v1/me", method="OPTIONS", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
        check(G, "CORS not granted to other origins", hdrs.get("access-control-allow-origin") not in ("*", "https://evil.example"))
        fn = Invoker(args, client_id).function
        cfg = aws("lambda", "get-function-configuration", "--function-name", fn)
        env = cfg["Environment"]["Variables"]
        check(G, "Lambda in private subnets with AppSG", len(cfg["VpcConfig"]["SubnetIds"]) == 2 and cfg["VpcConfig"]["SecurityGroupIds"] == [APP_SG])
        check(G, "Lambda uses ogevia_sv_test via ogevia_app; no secret values in env", env.get("DB_NAME") == "ogevia_sv_test" and env.get("DB_SET_ROLE") == "ogevia_app"
              and "password" not in json.dumps(env).lower())
    guarded(G, "api checks", api)

    E = "evidence"
    def evidence():
        pab = aws("s3api", "get-public-access-block", "--bucket", EVIDENCE_BUCKET)["PublicAccessBlockConfiguration"]
        check(E, "evidence bucket: Block Public Access (all 4)", all(pab.values()) and len(pab) == 4)
        enc = aws("s3api", "get-bucket-encryption", "--bucket", EVIDENCE_BUCKET)["ServerSideEncryptionConfiguration"]["Rules"][0]
        check(E, "evidence bucket: default SSE-KMS (customer key)", enc["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] == "aws:kms")
        check(E, "evidence bucket: versioning enabled", aws("s3api", "get-bucket-versioning", "--bucket", EVIDENCE_BUCKET).get("Status") == "Enabled")
        check(E, "evidence bucket: policy is not public", aws("s3api", "get-bucket-policy-status", "--bucket", EVIDENCE_BUCKET)["PolicyStatus"]["IsPublic"] is False)
        code, _, _ = http("https://%s.s3.%s.amazonaws.com/" % (EVIDENCE_BUCKET, REGION))
        check(E, "anonymous bucket listing denied", code == 403, "got %s" % code)
    guarded(E, "evidence checks", evidence)

    W = "web"
    def webchecks():
        code, h, body = http(web + "/")
        check(W, "CloudFront serves the app (200)", code == 200 and b'id="root"' in body, "got %s" % code)
        csp = h.get("content-security-policy", "")
        check(W, "CSP: self scripts, no framing", "script-src 'self'" in csp and "frame-ancestors 'none'" in csp)
        check(W, "HSTS, nosniff, X-Frame-Options DENY", "max-age=31536000" in h.get("strict-transport-security", "") and h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "DENY")
        code, _, body2 = http(web + "/service-verification")
        check(W, "SPA routing (/service-verification -> app)", code == 200 and b'id="root"' in body2, "got %s" % code)
        code, _, body3 = http(web + "/auth/callback")
        check(W, "SPA routing (/auth/callback -> app)", code == 200 and b'id="root"' in body3)
        code, _, cfg = http(web + "/config.json")
        rc = json.loads(cfg) if code == 200 else {}
        check(W, "runtime config: Cognito client + redirect + API URL correct", rc.get("VITE_COGNITO_CLIENT_ID") == client_id
              and rc.get("VITE_COGNITO_REDIRECT_URI") == web + "/auth/callback" and rc.get("VITE_SV_API_BASE_URL") == api_url
              and rc.get("VITE_COGNITO_USER_POOL_ID") == POOL)
        check(W, "runtime config holds identifiers only", not any(k for k in rc if any(w in k.upper() for w in ("SECRET", "PASSWORD", "TOKEN"))))
        import re
        m = re.search(rb'src="(/assets/[^"]+\.js)"', body)
        code_js = http(web + m.group(1).decode())[0] if m else 0
        check(W, "production AWS build assets load", code_js == 200, "got %s" % code_js)
        code, h = http_noredirect(web.replace("https://", "http://") + "/")
        check(W, "HTTP redirects to HTTPS", code in (301, 302, 307, 308) and h.get("location", "").startswith("https://"), "got %s" % code)
        login = urllib.parse.urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": web + "/auth/callback", "scope": "openid email",
                                        "state": "smoke", "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "code_challenge_method": "S256"})
        code, h = http_noredirect("https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com/oauth2/authorize?" + login)
        loc = h.get("location", "")
        check(W, "Cognito accepts this client + redirect URI (managed login)", code in (200, 302) and "error" not in loc.lower(), "got %s %s" % (code, loc[:80]))
    guarded(W, "web checks", webchecks)

    O = "observability"
    def obs():
        res = aws("cloudformation", "describe-stack-resources", "--stack-name", "Ogevia-prod-ServiceVerificationApi")["StackResources"]
        groups = [r["PhysicalResourceId"] for r in res if r["ResourceType"] == "AWS::Logs::LogGroup"]
        found = []
        for g in groups:
            found += [x for x in aws("logs", "describe-log-groups", "--log-group-name-prefix", g)["logGroups"] if x["logGroupName"] == g]
        check(O, "handler + access log groups exist with 365-day retention", len(groups) == 2 and len(found) == 2 and all(x.get("retentionInDays") == 365 for x in found))
        ores = aws("cloudformation", "describe-stack-resources", "--stack-name", "Ogevia-prod-Observability")["StackResources"]
        alarms = [r["PhysicalResourceId"] for r in ores if r["ResourceType"] == "AWS::CloudWatch::Alarm"]
        got = aws("cloudwatch", "describe-alarms", "--alarm-names", *alarms)["MetricAlarms"] if alarms else []
        check(O, "6 CloudWatch alarms exist", len(alarms) == 6 and len(got) == 6)
        topics = [r["PhysicalResourceId"] for r in ores if r["ResourceType"] == "AWS::SNS::Topic"]
        check(O, "SNS alarm topic exists", len(topics) == 1 and aws("sns", "get-topic-attributes", "--topic-arn", topics[0]).get("Attributes"))
        return groups
    groups = guarded(O, "observability checks", obs) or []

    S = "security"
    def sec():
        db = aws("rds", "describe-db-instances", "--db-instance-identifier", RDS_ID)["DBInstances"][0]
        check(S, "RDS not publicly accessible; encrypted", db["PubliclyAccessible"] is False and db["StorageEncrypted"] is True)
        perms = aws("ec2", "describe-security-groups", "--group-ids", RDS_SG)["SecurityGroups"][0]["IpPermissions"]
        check(S, "RDS SG unchanged: 5432 from AppSG only", len(perms) == 1 and perms[0]["FromPort"] == 5432 and [p["GroupId"] for p in perms[0]["UserIdGroupPairs"]] == [APP_SG] and not perms[0]["IpRanges"])
        inst = aws("ec2", "describe-instances", "--filters", "Name=tag:Name,Values=ogevia-db-admin-temp")["Reservations"][0]["Instances"][0]
        check(S, "admin host does not hold AppSG", APP_SG not in [g["GroupId"] for g in inst["SecurityGroups"]])
        site = out["SiteBucketName"]
        check(S, "site bucket not public", aws("s3api", "get-bucket-policy-status", "--bucket", site)["PolicyStatus"]["IsPublic"] is False
              and all(aws("s3api", "get-public-access-block", "--bucket", site)["PublicAccessBlockConfiguration"].values()))
    guarded(S, "security checks", sec)
    return groups


def log_check(groups, sensitive):
    if not groups:
        return
    handler = [g for g in groups if "Handler" in g] or groups
    time.sleep(10)
    since = str(int((time.time() - 1800) * 1000))
    events = []
    for g in handler:
        events += aws("logs", "filter-log-events", "--log-group-name", g, "--start-time", since)["events"]
    text = "\n".join(e["message"] for e in events)
    check("security", "Lambda logs written for this run", len(events) > 5, "%d events" % len(events))
    check("security", "no sub/org/visit ids, signature bytes or reasons in logs", not any(s and s in text for s in sensitive))
    check("security", "no token/password material in logs", "eyJ" not in text and "password" not in text.lower())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["aws", "local"], default="aws")
    p.add_argument("--outputs", help="JSON file with WebOrigin, ApiUrl, TestAppClientId, SiteBucketName")
    p.add_argument("--caregiver-sub", required=True)
    p.add_argument("--manager-sub", required=True)
    p.add_argument("--client-id", help="local mode: app client id the local handler accepts")
    p.add_argument("--pool", default=POOL)
    p.add_argument("--local-invoker")
    p.add_argument("--age-cmd")
    args = p.parse_args()
    out = json.load(open(args.outputs)) if args.outputs else {}
    client_id = out.get("TestAppClientId") or args.client_id
    print("\nOgevia test-slice smoke suite (%s mode)" % args.mode, flush=True)
    groups = infra(args, out) if args.mode == "aws" else []
    inv = Invoker(args, client_id)
    sens = guarded("workflow", "service verification workflow", lambda: workflow(args, inv, args.caregiver_sub, args.manager_sub))
    guarded("scheduled", "scheduled clean-signed visit", lambda: scheduled_workflow(args, inv, args.caregiver_sub, args.manager_sub))
    care_tokens = guarded("care", "care request workflow", lambda: care_workflow(args, inv, args.caregiver_sub, args.manager_sub)) or []
    if isinstance(sens, dict):
        sens["sensitive"] = sens.get("sensitive", []) + [t for t in care_tokens if t]
    if args.mode == "aws":
        log_check(groups, (sens or {}).get("sensitive", [args.caregiver_sub, args.manager_sub]))
    failed = [r for r in RESULTS if not r[2]]
    print("\n%d checks, %d passed, %d failed" % (len(RESULTS), len(RESULTS) - len(failed), len(failed)), flush=True)
    for r in failed:
        print("  FAILED: [%s] %s %s" % (r[0], r[1], r[3]), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
