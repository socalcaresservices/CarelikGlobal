#!/usr/bin/env python3
"""Ogevia PILOT/TEST regression runner (standard library only). Phase C of docs/TESTING_AND_RELEASE_PROCESS.md.

Runs the automatable cases of the acceptance-test catalog (docs/release-process/ACCEPTANCE_TEST_CATALOG.md): smoke set S
and regression set R, through the SAME invoker the existing smoke suites use (smoke.Invoker): API-Gateway-shaped events
carrying synthetic identities' claims, sent either
  aws    to the deployed pilot Lambda (IAM-gated; from CloudShell with admin credentials), or
  local  to a local handler (apps/sv-api/test/local-invoke.ts) over a database seeded like the pilot.
Every result is tagged with its catalog ID. A report (JSON and Markdown) is written for the release checklist, section C.

What it creates (SYNTHETIC, pilot/test only): ONE client "Regression <run id>" with ONE 10-hour monthly authorization, a few
shifts and one shift series on it, all cancelled/ended at the end, and the client set Inactive. Records are never deleted.
It also runs the standard Service Verification workflow (smoke.workflow) on the test-slice agency when given its identities.

What it does NOT cover (stays manual, see the catalog): screens and mobile layout, Cognito sign-in and MFA, S3/KMS evidence
objects, CloudFront, email, and anything marked NOT BUILT. The API Gateway JWT authorizer is checked only when --api-url is given.

Exit codes: 0 all cases ran and passed; 1 a case failed; 2 refused to start (safety); 3 some case could not run (not a pass).
Never prints tokens, passwords or secret values.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import sys
import time
import types
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke  # noqa: E402  (same directory)

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

RESULTS = []  # dicts: ids, name, status (PASS/FAIL/SKIP), detail
PILOT_SLUG = "scs-pilot-synthetic"
EXPECTED_DB = "ogevia_sv_test"
CAP = 600  # minutes: the regression authorization is 10 hours a month


def rec(ids, name, ok, detail="", skip=False):
    status = "SKIP" if skip else ("PASS" if ok else "FAIL")
    RESULTS.append({"ids": ids, "name": name, "status": status, "detail": detail})
    tail = (" (" + detail + ")") if detail and status != "PASS" else ""
    print("  %-4s  %-22s %s%s" % (status, "/".join(ids), name, tail), flush=True)
    return status == "PASS"


def guarded(ids, name, fn, *a):
    try:
        return fn(*a)
    except Exception as exc:  # list every case; never stop at the first failure
        rec(ids, name, False, "%s: %s" % (type(exc).__name__, str(exc)[:240]))
        return None


class Ctx:
    pass


def err_message(body):
    return ((body or {}).get("error") or {}).get("message", "")


def today_local(tz="America/Los_Angeles"):
    if ZoneInfo:
        return datetime.datetime.now(ZoneInfo(tz)).date()
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=8)).date()


def month_start(d):
    return d.replace(day=1)


def local_day(shift, tz="America/Los_Angeles"):
    """The shift's agency-local date. The deployed API returns it as YYYY-MM-DD; a bare local handler may return a timestamp."""
    v = str(shift.get("localDate") or "")
    if len(v) == 10 and v[4] == "-" and v[7] == "-":
        return v
    t = datetime.datetime.fromisoformat(str(shift["startsAt"]).replace("Z", "+00:00"))
    return (t.astimezone(ZoneInfo(tz)) if ZoneInfo else t - datetime.timedelta(hours=8)).date().isoformat()


# ------------------------------------------------------------------ calls
def call(c, route, sub, **kw):
    return c.inv.call(route, sub, **kw)


def balance(c, month):
    """The client's balance for a month, from the monthly service summary (the figure the client page shows)."""
    s, b = call(c, "GET /v1/reports/monthly-service-summary", c.mg,
                query={"organizationId": c.org, "monthStart": month.isoformat(), "clientId": c.client})
    rows = [r for r in (b or {}).get("services", []) if r.get("serviceId") == c.service]
    if s != 200 or len(rows) != 1:
        raise RuntimeError("balance unavailable: status %s rows %s" % (s, len(rows)))
    return {k: (int(v) if k.endswith("Minutes") and v is not None else v) for k, v in rows[0].items()}


def make_shift(c, day, start, end, caregiver=None, key=None):
    body = {"organizationId": c.org, "clientId": c.client, "serviceId": c.service, "date": day.isoformat(),
            "startTime": start, "endTime": end}
    if caregiver:
        body["caregiverRecordId"] = caregiver
    s, b = call(c, "POST /v1/shifts", c.mg, body=body, key=key)
    if s == 201 and b["shift"]["shiftId"] not in c.shifts:  # a retry returns the same shift: record it once
        c.shifts.append(b["shift"]["shiftId"])
    return s, b


def cancel_all(c, reason="regression run cleanup"):
    released = 0
    for sid in list(c.shifts):
        s, b = call(c, "POST /v1/shifts/{shiftId}/cancel", c.mg, path={"shiftId": sid}, body={"organizationId": c.org, "reason": reason})
        if s == 200:
            released += int((b or {}).get("releasedMinutes") or 0)
        c.shifts.remove(sid)
    return released


# ------------------------------------------------------------------ fixture
def setup(c, args):
    s, me = call(c, "GET /v1/me", c.mg)
    ms = [m for m in (me or {}).get("memberships", []) if m.get("organizationSlug") == args.org_slug]
    if s != 200 or len(ms) != 1:
        raise RuntimeError("manager is not a member of %s (status %s)" % (args.org_slug, s))
    c.org = ms[0]["organizationId"]
    s, b = call(c, "GET /v1/services", c.mg, query={"organizationId": c.org})
    svc = next((x for x in (b or {}).get("services", []) if x.get("code") == args.service_code and x.get("isActive")), None)
    if not svc:
        raise RuntimeError("no active service with code %s" % args.service_code)
    c.service = svc["serviceId"]
    s, b = call(c, "GET /v1/caregivers", c.mg, query={"organizationId": c.org})
    byc = {x["caregiverCode"]: x["caregiverRecordId"] for x in (b or {}).get("caregivers", [])}
    c.cg_a_rec, c.cg_b_rec = byc.get(args.caregiver_a_code), byc.get(args.caregiver_b_code)
    if not c.cg_a_rec or not c.cg_b_rec:
        raise RuntimeError("caregiver codes %s / %s not found in the agency" % (args.caregiver_a_code, args.caregiver_b_code))
    c.today = today_local()
    s, b = call(c, "POST /v1/clients", c.mg, body={"organizationId": c.org, "firstName": "Regression", "lastName": "Run " + c.run})
    if s != 201:
        raise RuntimeError("could not create the regression client: %s %s" % (s, err_message(b)))
    c.client = b["client"]["clientId"]
    s, b = call(c, "POST /v1/clients/{clientId}/authorizations", c.mg, path={"clientId": c.client}, body={
        "organizationId": c.org, "serviceId": c.service, "payer": "Synthetic Regression Payer", "monthlyAuthorizedMinutes": CAP,
        "periodStart": month_start(c.today).isoformat(), "periodEnd": (c.today + datetime.timedelta(days=120)).isoformat()})
    if s != 201:
        raise RuntimeError("could not create the regression authorization: %s %s" % (s, err_message(b)))
    c.auth = b["authorizationId"]


def teardown(c):
    try:
        cancel_all(c)
        s, b = call(c, "GET /v1/shift-series", c.mg, query={"organizationId": c.org})
        for sr in (b or {}).get("series", []):
            if sr.get("clientId") == c.client and not sr.get("endedAt") and not sr.get("endsOn"):
                call(c, "POST /v1/shift-series/{seriesId}/end", c.mg, path={"seriesId": sr["seriesId"]},
                     body={"organizationId": c.org, "fromDate": c.today.isoformat(), "reason": "regression run cleanup"})
        call(c, "POST /v1/clients/{clientId}/status", c.mg, path={"clientId": c.client},
             body={"organizationId": c.org, "status": "inactive", "reason": "Synthetic regression client, run " + c.run})
    except Exception as exc:  # cleanup must never hide the results
        print("  ....  cleanup problem (check the pilot by hand): %s" % str(exc)[:200], flush=True)


# ------------------------------------------------------------------ cases
def case_roles_and_isolation(c, args):
    for name, sub, role in (("manager", c.mg, "manager"), ("caregiver A", c.cg_a, "caregiver"), ("caregiver B", c.cg_b, "caregiver")):
        s, me = call(c, "GET /v1/me", sub)
        ms = [m for m in (me or {}).get("memberships", []) if m.get("organizationId") == c.org]
        rec(["SMK-01", "USR-01"], "%s signs in with role %s in exactly one membership of the agency" % (name, role),
            s == 200 and len(ms) == 1 and ms[0].get("role") == role, "status %s" % s)
    # caregiver cannot manage the agency
    s, b = make_shift(Ctx_as(c, c.cg_a), c.today + datetime.timedelta(days=3), "09:00", "10:00")
    rec(["USR-01", "SCH-13"], "caregiver cannot create a shift", s in (403, 404), "status %s" % s)
    s, b = call(c, "GET /v1/shifts", c.cg_a, query={"organizationId": c.org, "from": c.today.isoformat(),
                                                    "to": (c.today + datetime.timedelta(days=7)).isoformat()})
    rec(["USR-01", "SCH-13"], "caregiver cannot list the agency's shifts", s in (403, 404) or not (b or {}).get("shifts"), "status %s" % s)
    # caregiver view carries no names or payer identifiers
    s, b = call(c, "GET /v1/clients/assigned", c.cg_a, query={"organizationId": c.org})
    forbidden = {"firstName", "lastName", "legalFirstName", "legalLastName", "dateOfBirth", "dob", "uci", "medicaidId", "payerId", "payer"}
    leaked = sorted({k for cl in (b or {}).get("clients", []) for k in cl} & forbidden)
    rec(["SMK-04", "EVV-05"], "caregiver's client list carries codes only (no names, birth dates or payer identifiers)",
        s == 200 and not leaked, "status %s leaked %s" % (s, leaked))
    # other agency
    if c.other_mg:
        s, b = call(c, "GET /v1/clients", c.other_mg, query={"organizationId": c.org})
        listed = [x for x in (b or {}).get("clients", []) if x.get("clientId") == c.client]
        rec(["USR-02"], "another agency's manager cannot list this agency's clients", s in (403, 404) or not listed, "status %s" % s)
        s, b = call(c, "POST /v1/shifts", c.other_mg, body={"organizationId": c.org, "clientId": c.client, "serviceId": c.service,
                                                            "date": (c.today + datetime.timedelta(days=3)).isoformat(),
                                                            "startTime": "09:00", "endTime": "10:00"})
        rec(["USR-02"], "another agency's manager cannot create a shift here", s in (403, 404), "status %s" % s)
        s, b = call(c, "GET /v1/visits", c.other_mg, query={"organizationId": c.org})
        rec(["USR-02"], "another agency's manager cannot list this agency's visits", s in (403, 404) or not (b or {}).get("visits"), "status %s" % s)
    else:
        rec(["USR-02"], "other-agency isolation", False, "no --other-manager-sub given", skip=True)


def Ctx_as(c, sub):
    """A view of the context whose manager is another person (for refusal checks)."""
    d = types.SimpleNamespace(**c.__dict__)
    d.mg = sub
    d.shifts = []
    return d


def case_unauthenticated(c, args):
    r = c.inv.call("GET /v1/me", None)
    rec(["SMK-06"], "a call with no sign-in is refused (401)", r[0] == 401, "status %s" % r[0])
    bad = c.inv.claims(c.mg, {"iss": "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_FORGED000"})
    r = c.inv.call("GET /v1/me", None, claims=bad)
    rec(["SMK-06"], "a token from another issuer is refused (401)", r[0] == 401, "status %s" % r[0])
    bad = c.inv.claims(c.mg, {"client_id": "forgedclient000000000000000"})
    r = c.inv.call("GET /v1/me", None, claims=bad)
    rec(["SMK-06"], "a token for another app client is refused (401)", r[0] == 401, "status %s" % r[0])
    bad = c.inv.claims(c.mg, {"exp": str(int(time.time()) - 60)})
    r = c.inv.call("GET /v1/me", None, claims=bad)
    rec(["SMK-06"], "an expired token is refused (401)", r[0] == 401, "status %s" % r[0])
    if args.api_url:
        s, _, _ = smoke.http(args.api_url.rstrip("/") + "/v1/me")
        rec(["SMK-06"], "the deployed API refuses an anonymous request over HTTPS (401)", s == 401, "status %s" % s)
        s, _, _ = smoke.http(args.api_url.rstrip("/") + "/v1/me", headers={"authorization": "Bearer forged.token.value"})
        rec(["SMK-06"], "the deployed API refuses a forged token over HTTPS (401)", s == 401, "status %s" % s)
    else:
        rec(["SMK-06"], "API Gateway authorizer over HTTPS", False, "no --api-url given", skip=True)


def case_shifts(c, args):
    day = c.today + datetime.timedelta(days=2)
    month = month_start(day)
    base = balance(c, month)
    key = str(uuid.uuid4())
    s, b = make_shift(c, day, "09:00", "13:00", key=key)
    ok = s == 201 and b["shift"]["reservedMinutes"] == 240 and int(b["shift"]["remainingMinutes"]) == CAP - 240
    rec(["SCH-01"], "a 4-hour shift reserves 240 minutes and leaves 360", ok, "status %s %s" % (s, err_message(b)))
    first = b["shift"]["shiftId"] if s == 201 else None
    after = balance(c, month)
    rec(["SCH-01", "AUT-01"], "balance shows 240 reserved and 360 remaining",
        after["reservedMinutes"] - base["reservedMinutes"] == 240 and after["remainingMinutes"] == CAP - 240,
        "reserved %s remaining %s" % (after["reservedMinutes"], after["remainingMinutes"]))
    s2, b2 = make_shift(c, day, "09:00", "13:00", key=key)
    rec(["SCH-07"], "a retry with the same key returns the same shift and creates no second one",
        s2 == 201 and first and b2["shift"]["shiftId"] == first and len(set(c.shifts)) == len(c.shifts) == 1,
        "status %s" % s2)
    s, b = make_shift(c, day, "14:00", "21:00")
    rec(["SCH-02"], "a 7-hour shift is refused when 6 hours remain, with the exact hours stated",
        s == 409 and "Not enough authorized time" in err_message(b) and "6 hr" in err_message(b) and "7 hr" in err_message(b),
        "status %s %s" % (s, err_message(b)))
    # Two schedulers at once for the last hours: exactly one of two 4-hour shifts fits in 6 hours.
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        futs = [pool.submit(lambda t: make_shift(c, day, *t), t) for t in (("14:00", "18:00"), ("14:30", "18:30"))]
        out = [f.result() for f in futs]
    codes = sorted(s for s, _ in out)
    rec(["SCH-03"], "two simultaneous 4-hour shifts for the last 6 hours: exactly one is accepted",
        codes == [201, 409], "statuses %s" % codes)
    final = balance(c, month)
    rec(["SCH-03", "AUT-01"], "after the race the reserved total never exceeds the authorization",
        final["reservedMinutes"] - base["reservedMinutes"] <= CAP and final["remainingMinutes"] >= 0,
        "reserved %s remaining %s" % (final["reservedMinutes"], final["remainingMinutes"]))
    released = cancel_all(c)
    back = balance(c, month)
    rec(["SCH-10"], "cancelling releases the reserved time (480 minutes) and the balance returns to its start",
        released == 480 and back["reservedMinutes"] == base["reservedMinutes"] and back["remainingMinutes"] == base["remainingMinutes"],
        "released %s reserved %s remaining %s" % (released, back["reservedMinutes"], back["remainingMinutes"]))
    s, b = call(c, "POST /v1/shifts/{shiftId}/cancel", c.mg, path={"shiftId": first}, body={"organizationId": c.org, "reason": "again"})
    rec(["SCH-10"], "a cancelled shift cannot be changed again", s in (409, 422), "status %s" % s)

    # caregiver overlap, with capacity free so the refusal is for the overlap
    s, b = make_shift(c, day, "09:00", "11:00", caregiver=c.cg_a_rec)
    s2, b2 = make_shift(c, day, "10:00", "12:00", caregiver=c.cg_a_rec)
    rec(["SCH-04"], "the same caregiver cannot be booked for overlapping shifts",
        s == 201 and s2 in (409, 422) and "Not enough authorized" not in err_message(b2), "statuses %s/%s %s" % (s, s2, err_message(b2)))
    cancel_all(c)

    # call-out, replacement, history
    s, b = make_shift(c, day, "09:00", "12:00", caregiver=c.cg_a_rec)
    sid = b["shift"]["shiftId"] if s == 201 else None
    s1, o1 = call(c, "POST /v1/shifts/{shiftId}/callout", c.mg, path={"shiftId": sid}, body={"organizationId": c.org, "reason": "Regression call-out"}) if sid else (0, None)
    s2, o2 = call(c, "POST /v1/shifts/{shiftId}/caregiver", c.mg, path={"shiftId": sid}, body={
        "organizationId": c.org, "caregiverRecordId": c.cg_b_rec, "reason": "Regression replacement"}) if sid else (0, None)
    s3, ev = call(c, "GET /v1/shifts/{shiftId}/coverage", c.mg, path={"shiftId": sid}, query={"organizationId": c.org}) if sid else (0, None)
    bal = balance(c, month)
    rec(["SCH-09"], "call-out makes the shift need coverage; a replacement covers it; history keeps both; reserved time unchanged",
        s1 == 200 and o1.get("coverageState") == "needs_coverage" and s2 == 200 and o2.get("coverageState") == "covered"
        and s3 == 200 and len((ev or {}).get("events", [])) >= 2 and bal["reservedMinutes"] - base["reservedMinutes"] == 180,
        "statuses %s/%s/%s reserved %s" % (s1, s2, s3, bal["reservedMinutes"]))
    cancel_all(c)


def case_series(c, args):
    start = c.today + datetime.timedelta(days=1)
    end = start + datetime.timedelta(days=27)
    q = {"organizationId": c.org, "clientId": c.client, "serviceId": c.service, "weekdays": "0,1,2,3,4,5,6",
         "startTime": "08:00", "endTime": "10:00", "startsOn": start.isoformat(), "endsOn": end.isoformat()}
    s, b = call(c, "GET /v1/shift-series/preview", c.mg, query=q)
    occ = [{k: (int(v) if k.endswith("Minutes") and v is not None else v) for k, v in o.items()} | {"minutes": int(o["minutes"])}
           for o in (b or {}).get("occurrences", [])]
    ok_rows = [o for o in occ if o["outcome"] == "ok"]
    flagged = [o for o in occ if o["outcome"] != "ok"]
    rec(["REC-01"], "the preview lists every date with its outcome before anything is saved",
        s == 200 and len(occ) == 28 and all("outcome" in o and "localDate" in o for o in occ), "status %s rows %s" % (s, len(occ)))
    months = {}
    for o in occ:
        m = months.setdefault(o["monthStart"], {"avail": None, "okmin": 0})
        if m["avail"] is None and o.get("authorizedMinutes") is not None and o.get("usedMinutes") is not None:
            m["avail"] = o["authorizedMinutes"] - o["usedMinutes"] - o["reservedMinutes"]
        if o["outcome"] == "ok":
            m["okmin"] += o["minutes"]
    within = all(m["avail"] is None or m["okmin"] <= m["avail"] for m in months.values())
    rec(["REC-02"], "in every month the dates marked ok fit the hours still available; nothing is shortened",
        within and len(flagged) >= 1 and all(o["outcome"] == "exceeds_authorization" or o["outcome"] != "ok" for o in flagged),
        "months %s flagged %s" % ({k: (v['okmin'], v['avail']) for k, v in months.items()}, len(flagged)))
    body = {"organizationId": c.org, "clientId": c.client, "serviceId": c.service, "weekdays": [0, 1, 2, 3, 4, 5, 6],
            "startTime": "08:00", "endTime": "10:00", "startsOn": start.isoformat(), "endsOn": end.isoformat()}
    s, b = call(c, "POST /v1/shift-series", c.mg, body={**body, "onConflict": "refuse"})
    rec(["REC-02"], "creating the series while dates are flagged is refused and saves nothing",
        s == 409 and not [x for x in (call(c, "GET /v1/shifts", c.mg, query={"organizationId": c.org, "clientId": c.client,
                                                                              "from": start.isoformat(), "to": end.isoformat()})[1] or {}).get("shifts", [])
                          if x.get("shiftStatus") == "scheduled"], "status %s %s" % (s, err_message(b)))
    s, b = call(c, "POST /v1/shift-series", c.mg, body={**body, "onConflict": "skip_flagged"})
    series = (b or {}).get("series", {})
    rec(["REC-03", "REC-02"], "choosing to skip creates exactly the dates marked ok and records the rest as skipped",
        s == 201 and series.get("created") == len(ok_rows) and series.get("skipped") == len(flagged),
        "status %s created %s skipped %s (preview ok %s flagged %s)" % (s, series.get("created"), series.get("skipped"), len(ok_rows), len(flagged)))
    sid = series.get("seriesId")
    s, b = call(c, "GET /v1/shifts", c.mg, query={"organizationId": c.org, "clientId": c.client, "from": start.isoformat(), "to": end.isoformat()})
    mine = sorted([x for x in (b or {}).get("shifts", []) if x.get("seriesId") == sid and x.get("shiftStatus") == "scheduled"], key=lambda x: x["startsAt"])
    if mine:
        one = mine[0]
        day = local_day(one)
        s, r = call(c, "POST /v1/shifts/{shiftId}/reschedule", c.mg, path={"shiftId": one["shiftId"]}, body={
            "organizationId": c.org, "date": day, "startTime": "10:00", "endTime": "12:00", "reason": "Regression: change this date only"})
        s2, b2 = call(c, "GET /v1/shifts", c.mg, query={"organizationId": c.org, "clientId": c.client, "from": start.isoformat(), "to": end.isoformat()})
        sched = [x for x in (b2 or {}).get("shifts", []) if x.get("seriesId") == sid and x.get("shiftStatus") == "scheduled"]
        moved = next((x for x in sched if x["shiftId"] == one["shiftId"]), None)
        rec(["REC-09"], "changing one occurrence moves only that date; the others and the count are unchanged",
            s == 200 and moved is not None and moved["startsAt"] != one["startsAt"] and len(sched) == len(mine),
            "status %s count %s/%s" % (s, len(sched), len(mine)))
    else:
        rec(["REC-09"], "changing one occurrence", False, "no occurrences found")
    s, b = call(c, "POST /v1/shift-series/{seriesId}/end", c.mg, path={"seriesId": sid}, body={
        "organizationId": c.org, "fromDate": start.isoformat(), "reason": "Regression: end the series"})
    res = (b or {}).get("result", {})
    left = [x for x in (call(c, "GET /v1/shifts", c.mg, query={"organizationId": c.org, "clientId": c.client, "from": start.isoformat(), "to": end.isoformat()})[1] or {}).get("shifts", [])
            if x.get("seriesId") == sid and x.get("shiftStatus") == "scheduled"]
    rec(["REC-10", "REC-11"], "ending the series from its first date cancels every scheduled occurrence and releases their time",
        s == 200 and res.get("cancelled") == len(mine) and not left and res.get("releasedMinutes", 0) >= 60 * len(mine),
        "status %s result %s left %s" % (s, res, len(left)))
    for m in sorted(months):
        bal = balance(c, datetime.date.fromisoformat(m))
        rec(["AUT-01", "REC-10"], "after ending the series the reserved time for %s is back to zero" % m,
            bal["reservedMinutes"] == 0 and bal["remainingMinutes"] == CAP, "reserved %s remaining %s" % (bal["reservedMinutes"], bal["remainingMinutes"]))


def case_reports(c, args):
    month = month_start(c.today)
    s, b = call(c, "GET /v1/reports/monthly-service-summary", c.mg, query={"organizationId": c.org, "monthStart": month.isoformat()})
    summary = (b or {}).get("services", [])
    s2, u = call(c, "GET /v1/reports/utilisation", c.mg, query={"organizationId": c.org, "monthStart": month.isoformat()})
    util = {x["serviceId"]: x for x in (u or {}).get("services", [])}
    mism = []
    for sid, row in util.items():
        rows = [r for r in summary if r["serviceId"] == sid]
        for a_key, u_key in (("authorizedMinutes", "authorizedMinutes"), ("remainingMinutes", "remainingMinutes"), ("billableMinutes", "billableMinutes")):
            if sum(int(r[a_key]) for r in rows) != int(row[u_key]):
                mism.append((row.get("serviceCode"), a_key, sum(int(r[a_key]) for r in rows), row[u_key]))
    rec(["RPT-01", "DSH-01"], "the dashboard's hours by service equal the sum of the client balances (authorized, billable, remaining)",
        s == 200 and s2 == 200 and not mism, "status %s/%s mismatches %s" % (s, s2, mism[:3]))
    for r in summary:
        if int(r["remainingMinutes"]) != max(int(r["authorizedMinutes"]) - int(r["billableMinutes"]) - int(r.get("reservedMinutes") or 0), 0):
            rec(["AUT-01"], "every balance row: remaining = authorized - billable - reserved (never below zero)", False,
                "client %s: %s" % (r.get("clientCode"), {k: r.get(k) for k in ("authorizedMinutes", "billableMinutes", "reservedMinutes", "remainingMinutes")}))
            return
    rec(["AUT-01"], "every balance row: remaining = authorized - billable - reserved (never below zero)", True)
    s, a = call(c, "GET /v1/attention", c.mg, query={"organizationId": c.org})
    sm = (a or {}).get("summary") or {}
    nums = [sm.get(k) for k in ("missingTimeOut", "notConfirmed", "needsReview")]
    rec(["DSH-02"], "Action needed counts are whole numbers, never negative or missing",
        s == 200 and all(isinstance(n, int) and n >= 0 for n in nums), "status %s %s" % (s, nums))


def case_workflow(c, args):
    if not (args.test_caregiver_sub and args.test_manager_sub):
        rec(["VIS-01", "VIS-02", "VIS-05", "VIS-06", "VIS-08", "EVV-01", "SMK-05"],
            "standard Service Verification workflow (smoke.workflow)", False, "no --test-caregiver-sub/--test-manager-sub given", skip=True)
        return
    before = len(smoke.RESULTS)
    smoke.workflow(args, c.inv, args.test_caregiver_sub, args.test_manager_sub)
    new = smoke.RESULTS[before:]
    failed = [r for r in new if not r[2]]
    rec(["VIS-01", "VIS-02", "VIS-04", "VIS-05", "VIS-06", "VIS-08", "VIS-11", "EVV-01", "SMK-05"],
        "standard Service Verification workflow: %d checks (start, end, confirm, lock, correction, billing review)" % len(new),
        bool(new) and not failed, "; ".join("%s %s" % (r[1], r[3]) for r in failed[:3]) or "no checks ran")


# ------------------------------------------------------------------ safety and reporting
def verify_pilot_target(inv, args):
    """aws mode: refuse unless the function is the PILOT function on the TEST database. Read-only."""
    cfg = smoke.aws("lambda", "get-function-configuration", "--function-name", inv.function)
    env = (cfg.get("Environment") or {}).get("Variables", {})
    db = env.get("DB_NAME")
    if db != args.expect_db:
        print("REFUSED: the Lambda's DB_NAME is %r, expected %r. This runner is for the pilot/test environment only." % (db, args.expect_db), file=sys.stderr)
        sys.exit(2)
    if env.get("OGEVIA_ENV") == "prd":
        print("REFUSED: OGEVIA_ENV is prd.", file=sys.stderr)
        sys.exit(2)
    return {"database": db, "ogeviaEnv": env.get("OGEVIA_ENV")}


def write_report(args, run, meta):
    counts = {k: sum(1 for r in RESULTS if r["status"] == k) for k in ("PASS", "FAIL", "SKIP")}
    ids = {}
    for r in RESULTS:
        for i in r["ids"]:
            cur = ids.get(i, "PASS")
            ids[i] = "FAIL" if r["status"] == "FAIL" or cur == "FAIL" else ("SKIP" if r["status"] == "SKIP" or cur == "SKIP" else "PASS")
    doc = {"run": run, "finishedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "mode": args.mode,
           "commit": args.commit, "target": meta, "counts": counts, "catalog": dict(sorted(ids.items())), "results": RESULTS}
    os.makedirs(args.report_dir, exist_ok=True)
    base = os.path.join(args.report_dir, "pilot-regression-%s" % run)
    with open(base + ".json", "w") as f:
        json.dump(doc, f, indent=2)
    lines = ["# Pilot regression run %s" % run, "", "- Finished (UTC): %s" % doc["finishedUtc"], "- Mode: %s" % args.mode,
             "- Commit: %s" % (args.commit or "not given"), "- Target: %s" % json.dumps(meta),
             "- Result: %d passed, %d failed, %d not run" % (counts["PASS"], counts["FAIL"], counts["SKIP"]), "",
             "## Catalog IDs", "", "| ID | Result |", "|---|---|"] + ["| %s | %s |" % (k, v) for k, v in sorted(ids.items())] + \
            ["", "## Cases", "", "| IDs | Case | Result | Detail |", "|---|---|---|---|"] + \
            ["| %s | %s | %s | %s |" % (", ".join(r["ids"]), r["name"].replace("|", "/"), r["status"], r["detail"].replace("|", "/")[:160]) for r in RESULTS]
    with open(base + ".md", "w") as f:
        f.write("\n".join(lines) + "\n")
    return base


def main():
    p = argparse.ArgumentParser(description="Ogevia pilot/test regression runner (catalog sets S and R, API level).")
    p.add_argument("--mode", choices=["aws", "local"], default="aws")
    p.add_argument("--client-id", required=True, help="the pilot app client id (local mode: the id the local handler accepts)")
    p.add_argument("--pool", default=smoke.POOL)
    p.add_argument("--org-slug", default=PILOT_SLUG)
    p.add_argument("--service-code", default="RSP")
    p.add_argument("--manager-sub", required=True)
    p.add_argument("--caregiver-a-sub", required=True)
    p.add_argument("--caregiver-b-sub", required=True)
    p.add_argument("--caregiver-a-code", required=True, help="caregiver code of caregiver A, e.g. SCS-CG-A")
    p.add_argument("--caregiver-b-code", required=True)
    p.add_argument("--other-manager-sub", help="a manager of ANOTHER agency, for tenant-isolation cases")
    p.add_argument("--test-caregiver-sub", help="test-slice caregiver, for the standard Service Verification workflow")
    p.add_argument("--test-manager-sub")
    p.add_argument("--api-url", help="the deployed API URL, for the HTTPS authorizer checks")
    p.add_argument("--commit", help="commit SHA under test (recorded in the report; required in aws mode)")
    p.add_argument("--local-invoker")
    p.add_argument("--age-cmd")
    p.add_argument("--expect-db", default=EXPECTED_DB)
    p.add_argument("--report-dir", default=os.path.expanduser("~/ogevia-regression-reports"), help="where the JSON and Markdown report are written (default ~/ogevia-regression-reports)")
    p.add_argument("--allow-skip", action="store_true", help="exit 0 even if some cases could not run (never for a release gate)")
    p.add_argument("--i-am-targeting-the-pilot", action="store_true", help="required in aws mode: confirms the target is pilot/test, never production")
    args = p.parse_args()

    if args.mode == "aws":
        if not args.i_am_targeting_the_pilot:
            print("REFUSED: aws mode needs --i-am-targeting-the-pilot (this runner creates synthetic records and is for pilot/test only).", file=sys.stderr)
            sys.exit(2)
        if not args.commit:
            print("REFUSED: aws mode needs --commit <sha> so the report names what was tested.", file=sys.stderr)
            sys.exit(2)
    elif not args.local_invoker:
        print("REFUSED: local mode needs --local-invoker.", file=sys.stderr)
        sys.exit(2)

    inv = smoke.Invoker(args, args.client_id)
    meta = {"function": inv.function} if inv.function else {"local": True}
    if args.mode == "aws":
        meta.update(verify_pilot_target(inv, args))

    run = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print("\nOgevia pilot regression run %s (%s mode)\n" % (run, args.mode), flush=True)
    c = Ctx()
    c.inv, c.run, c.mg, c.cg_a, c.cg_b, c.other_mg, c.shifts = inv, run, args.manager_sub, args.caregiver_a_sub, args.caregiver_b_sub, args.other_manager_sub, []
    try:
        setup(c, args)
        guarded(["SMK-01", "USR-01"], "roles, caregiver view, tenant isolation", case_roles_and_isolation, c, args)
        guarded(["SMK-06"], "unauthenticated and forged requests", case_unauthenticated, c, args)
        guarded(["SCH-01"], "scheduling", case_shifts, c, args)
        guarded(["REC-01"], "recurrence", case_series, c, args)
        guarded(["RPT-01"], "reports and balances", case_reports, c, args)
        guarded(["VIS-01"], "service verification workflow", case_workflow, c, args)
    except Exception as exc:
        rec(["SETUP"], "fixture setup", False, "%s: %s" % (type(exc).__name__, str(exc)[:240]))
    finally:
        if getattr(c, "client", None):
            teardown(c)
    base = write_report(args, run, meta)
    counts = {k: sum(1 for r in RESULTS if r["status"] == k) for k in ("PASS", "FAIL", "SKIP")}
    print("\n%d cases passed, %d failed, %d could not run. Report: %s.md / .json" % (counts["PASS"], counts["FAIL"], counts["SKIP"], base), flush=True)
    for r in RESULTS:
        if r["status"] == "FAIL":
            print("  FAILED: [%s] %s %s" % ("/".join(r["ids"]), r["name"], r["detail"]), flush=True)
    sys.exit(1 if counts["FAIL"] else (3 if counts["SKIP"] and not args.allow_skip else 0))


if __name__ == "__main__":
    main()
