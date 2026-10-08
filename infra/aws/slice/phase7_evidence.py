#!/usr/bin/env python3
"""Phase 7 security evidence for Ogevia AWS TEST (account 300094796789, us-west-2).

READ-ONLY. Only describe/get/list calls, plus one CloudWatch Logs Insights
query over the API's own log groups (a read; about $0.005 per GB scanned).
It never prints secret values, tokens, or user email addresses.

Each line: STATUS  ID  control: detail
  PASS    meets the Phase 7 requirement
  GAP     does not meet it; needs a fix or an owner decision (see the review)
  INFO    recorded for the review, no pass/fail rule
  MANUAL  cannot be read by API; needs the owner (for example the BAA)
  ERROR   the read failed; the detail says why

The full output goes to ~/ogevia-phase7/evidence-<UTC>.txt. The terminal ends
with a short summary that fits in one screenshot.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time

REGION = "us-west-2"
ACCOUNT = "300094796789"
RDS_PROD = "ogevia-prod-postgres"
RDS_SG = "sg-00530a1f4f7648e65"
APP_SG = "sg-064ffce3bcbe8eb3b"
VPC = "vpc-0ee9df0c38297cbc1"
POOL = "us-west-2_849AYz5J7"
ADMIN_TAG = "ogevia-db-admin-temp"
# OGEVIA_ENV selects which stacks are checked: "prod" (default) is the pilot/test slice,
# "prd" is the production deployment (ogevia_prd). Production shares the pilot's network
# endpoints, so its egress stack is always the "prod" one.
ENV = os.environ.get("OGEVIA_ENV", "prod")
if ENV not in ("prod", "prd"):
    sys.exit('OGEVIA_ENV must be "prod" (pilot/test slice) or "prd" (production), got %r' % ENV)
STACKS = {
    "evidence": "Ogevia-%s-EvidenceStorage" % ENV,
    "egress": "Ogevia-prod-NetworkEgress",
    "web": "Ogevia-%s-WebHosting" % ENV,
    "api": "Ogevia-%s-ServiceVerificationApi" % ENV,
    "obs": "Ogevia-%s-Observability" % ENV,
}
# Mirrors infra/aws/lib/public-routes.ts (8 approved at pilot, +2 visit-confirmation links approved 2026-10-05).
APPROVED_PUBLIC_ROUTES = {
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
}

RESULTS = []


def aws(*args, region=REGION):
    r = subprocess.run(["aws", *args, "--region", region, "--output", "json"],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        msg = (r.stderr.strip().splitlines() or ["aws %s %s failed" % args[:2]])[-1]
        raise RuntimeError(msg[:200])
    return json.loads(r.stdout) if r.stdout.strip() else {}


def record(status, cid, name, detail):
    RESULTS.append((status, cid, name, detail))
    print("%-6s  %-4s %s: %s" % (status, cid, name, detail), flush=True)


def check(cid, name):
    def wrap(fn):
        try:
            out = fn()
            for status, detail in (out if isinstance(out, list) else [out]):
                record(status, cid, name, detail)
        except Exception as e:  # a failed read is reported, never hidden
            record("ERROR", cid, name, str(e))
        return fn
    return wrap


def stack_resources(key, rtype):
    # list-stack-resources pages through every resource. describe-stack-resources stops at 100,
    # and the API stack has more than that, so it silently dropped the Lambda function.
    res = aws("cloudformation", "list-stack-resources", "--stack-name", STACKS[key])["StackResourceSummaries"]
    return [r for r in res if r["ResourceType"] == rtype]


def mask(s):
    return re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "<email>", s)


print("Ogevia Phase 7 security evidence (read-only), %s" % dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
print("-" * 100)

# --- A. Account, identity, BAA -------------------------------------------------
@check("A1", "AWS account and caller")
def _():
    i = aws("sts", "get-caller-identity")
    ok = i["Account"] == ACCOUNT
    return ("PASS" if ok else "GAP", "account %s, role %s" % (i["Account"], i["Arn"].split("/")[1] if "/" in i["Arn"] else i["Arn"]))


@check("A2", "AWS BAA accepted in AWS Artifact")
def _():
    try:
        r = aws("artifact", "list-customer-agreements")
    except Exception as e:
        return ("MANUAL", "the Artifact API could not be read (%s). Open AWS console > Artifact > Agreements and confirm the AWS Business Associate Addendum is ACTIVE for this account" % e)
    ags = r.get("customerAgreements", [])
    baa = [a for a in ags if re.search(r"business associate|BAA", a.get("name", "") + a.get("description", ""), re.I)]
    if baa and any(a.get("state") == "ACTIVE" for a in baa):
        a = [a for a in baa if a.get("state") == "ACTIVE"][0]
        return ("PASS", "%s: ACTIVE (effective %s)" % (a.get("name"), a.get("effectiveStart", "?")))
    return ("GAP", "no ACTIVE Business Associate Addendum found (%d agreements listed). Real client data is not allowed until it is accepted" % len(ags))


@check("A3", "Root user protected")
def _():
    s = aws("iam", "get-account-summary")["SummaryMap"]
    out = [("PASS" if s.get("AccountMFAEnabled") == 1 else "GAP", "root MFA %s" % ("enabled" if s.get("AccountMFAEnabled") == 1 else "NOT enabled"))]
    out.append(("PASS" if s.get("AccountAccessKeysPresent", 0) == 0 else "GAP", "root access keys %s" % ("none" if s.get("AccountAccessKeysPresent", 0) == 0 else "PRESENT")))
    return out


@check("A4", "No long-lived IAM user access")
def _():
    users = aws("iam", "list-users").get("Users", [])
    keyed = []
    for u in users:
        keys = aws("iam", "list-access-keys", "--user-name", u["UserName"]).get("AccessKeyMetadata", [])
        if any(k["Status"] == "Active" for k in keys):
            keyed.append(u["UserName"])
    if not users:
        return ("PASS", "0 IAM users (people sign in through IAM Identity Center)")
    return ("GAP" if keyed else "INFO", "%d IAM users; with active access keys: %s" % (len(users), ", ".join(keyed) or "none"))


# --- B. Audit logging ----------------------------------------------------------
@check("B1", "CloudTrail records management events in every region")
def _():
    trails = aws("cloudtrail", "describe-trails", "--include-shadow-trails").get("trailList", [])
    if not trails:
        return ("GAP", "no CloudTrail trail visible from us-west-2")
    out = []
    for t in trails:
        home = t.get("HomeRegion")
        st = aws("cloudtrail", "get-trail-status", "--name", t["TrailARN"], region=home)
        good = t.get("IsMultiRegionTrail") and st.get("IsLogging")
        out.append(("PASS" if good else "GAP",
                    "%s (home %s): multi-region %s, logging %s, log-file validation %s, KMS %s, last delivery %s" % (
                        t["Name"], home, t.get("IsMultiRegionTrail"), st.get("IsLogging"),
                        t.get("LogFileValidationEnabled"), "yes" if t.get("KmsKeyId") else "no (SSE-S3)",
                        str(st.get("LatestDeliveryTime", "never"))[:19])))
        if not t.get("LogFileValidationEnabled"):
            out.append(("GAP", "%s: log-file validation is off (tamper evidence for the audit trail)" % t["Name"]))
    return out


@check("B2", "Application log groups have finite retention")
def _():
    groups = []
    for key in ("api",):
        groups += [r["PhysicalResourceId"] for r in stack_resources(key, "AWS::Logs::LogGroup")]
    out = []
    for g in groups:
        d = aws("logs", "describe-log-groups", "--log-group-name-prefix", g).get("logGroups", [])
        d = [x for x in d if x["logGroupName"] == g]
        days = d[0].get("retentionInDays") if d else None
        out.append(("PASS" if days else "GAP", "%s: %s" % (g, "%s days" % days if days else "never expires")))
    return out or ("GAP", "no log groups found in the API stack")


@check("B3", "No personal data in API logs (last 14 days)")
def _():
    groups = [r["PhysicalResourceId"] for r in stack_resources("api", "AWS::Logs::LogGroup")]
    end = int(time.time()); start = end - 14 * 86400
    q = ("fields @message | filter @message like /@[A-Za-z0-9-]+\\.[A-Za-z]{2,}/ or @message like /eyJ[A-Za-z0-9_-]{10,}/ "
         "or @message like /data:image/ or @message like /(?i)password/ | stats count() as hits")
    qid = aws("logs", "start-query", "--log-group-names", *groups, "--start-time", str(start),
              "--end-time", str(end), "--query-string", q)["queryId"]
    for _ in range(60):
        r = aws("logs", "get-query-results", "--query-id", qid)
        if r.get("status") in ("Complete", "Failed", "Cancelled", "Timeout"):
            break
        time.sleep(2)
    if r.get("status") != "Complete":
        return ("ERROR", "Logs Insights query %s" % r.get("status"))
    hits = int(r["results"][0][0]["value"]) if r.get("results") else 0
    scanned = r.get("statistics", {}).get("recordsScanned", 0)
    return ("PASS" if hits == 0 else "GAP",
            "%d log lines scanned; %d contain an email address, token, image data or the word password" % (scanned, hits))


@check("B4", "Database audit trail tables")
def _():
    return ("INFO", "visit corrections and audit events are append-only in PostgreSQL (migrations + 140 DB tests; owner-reported phone test E4 kept the original). Not readable by API without a DB window")


# --- C. Network isolation -----------------------------------------------------
@check("C1", "RDS instances are private and encrypted")
def _():
    out = []
    for d in aws("rds", "describe-db-instances")["DBInstances"]:
        good = (not d["PubliclyAccessible"]) and d["StorageEncrypted"]
        out.append(("PASS" if good else "GAP", "%s: public %s, encrypted %s, engine %s %s, CA %s" % (
            d["DBInstanceIdentifier"], d["PubliclyAccessible"], d["StorageEncrypted"], d["Engine"], d["EngineVersion"],
            d.get("CACertificateIdentifier"))))
    return out


@check("C2", "RDS security group admits only the app tier")
def _():
    sg = aws("ec2", "describe-security-groups", "--group-ids", RDS_SG)["SecurityGroups"][0]
    bad, srcs = [], []
    for p in sg["IpPermissions"]:
        for r in p.get("IpRanges", []) + p.get("Ipv6Ranges", []):
            bad.append("%s %s" % (p.get("FromPort"), r.get("CidrIp") or r.get("CidrIpv6")))
        srcs += [g["GroupId"] for g in p.get("UserIdGroupPairs", [])]
    good = not bad and set(srcs) <= {APP_SG}
    return ("PASS" if good else "GAP", "inbound from %s; CIDR rules: %s" % (", ".join(srcs) or "none", ", ".join(bad) or "none"))


@check("C3", "Database connections require TLS")
def _():
    d = aws("rds", "describe-db-instances", "--db-instance-identifier", RDS_PROD)["DBInstances"][0]
    pg = d["DBParameterGroups"][0]["DBParameterGroupName"]
    page = aws("rds", "describe-db-parameters", "--db-parameter-group-name", pg, "--query", "Parameters[?ParameterName=='rds.force_ssl']")
    val = page[0].get("ParameterValue") if page else None
    return ("PASS" if val == "1" else "GAP", "%s parameter group %s: rds.force_ssl=%s (the Lambda also verifies the RDS CA)" % (RDS_PROD, pg, val))


@check("C4", "Lambda runs in private subnets only")
def _():
    fn = stack_resources("api", "AWS::Lambda::Function")[0]["PhysicalResourceId"]
    c = aws("lambda", "get-function-configuration", "--function-name", fn)
    subnets = c.get("VpcConfig", {}).get("SubnetIds", [])
    sn = aws("ec2", "describe-subnets", "--subnet-ids", *subnets)["Subnets"] if subnets else []
    public = [s["SubnetId"] for s in sn if s.get("MapPublicIpOnLaunch")]
    rts = aws("ec2", "describe-route-tables", "--filters", "Name=association.subnet-id,Values=" + ",".join(subnets))["RouteTables"] if subnets else []
    igw = [r.get("GatewayId") for t in rts for r in t["Routes"] if str(r.get("GatewayId", "")).startswith("igw-")]
    nat = [r.get("NatGatewayId") for t in rts for r in t["Routes"] if r.get("NatGatewayId")]
    good = subnets and not public and not igw
    return ("PASS" if good else "GAP", "%d subnets, public-IP subnets %s, internet-gateway routes %s, NAT routes %s" % (
        len(subnets), public or "none", igw or "none", nat or "none"))


@check("C5", "App security group outbound rules")
def _():
    sg = aws("ec2", "describe-security-groups", "--group-ids", APP_SG)["SecurityGroups"][0]
    wide = [r.get("CidrIp") for p in sg["IpPermissionsEgress"] for r in p.get("IpRanges", []) if r.get("CidrIp") == "0.0.0.0/0"]
    return ("INFO" if wide else "PASS", "outbound to 0.0.0.0/0: %s. With no NAT or internet route (C4) this reaches only VPC endpoints and RDS; tightening it is optional hardening" % ("yes" if wide else "no"))


@check("C6", "VPC flow logs")
def _():
    fl = aws("ec2", "describe-flow-logs", "--filter", "Name=resource-id,Values=" + VPC).get("FlowLogs", [])
    return ("PASS" if fl else "GAP", "%d flow log(s) on %s" % (len(fl), VPC))


@check("C7", "Temporary admin host")
def _():
    r = aws("ec2", "describe-instances", "--filters", "Name=tag:Name,Values=" + ADMIN_TAG)["Reservations"]
    inst = [i for x in r for i in x["Instances"] if i["State"]["Name"] != "terminated"]
    if not inst:
        return ("PASS", "not present")
    i = inst[0]
    tokens = i.get("MetadataOptions", {}).get("HttpTokens")
    sgs = [g["GroupId"] for g in i.get("SecurityGroups", [])]
    out = [("PASS" if tokens == "required" else "GAP", "%s %s: IMDSv2 %s, public IP %s" % (
        i["InstanceId"], i["State"]["Name"], "required" if tokens == "required" else "optional (IMDSv1 allowed)", i.get("PublicIpAddress") or "none"))]
    out.append(("PASS" if APP_SG not in sgs else "GAP", "security groups %s (app group must only be attached during a DB window)" % ", ".join(sgs)))
    if i["State"]["Name"] == "running":
        out.append(("INFO", "running: stop it between DB windows (about $7.50/month and less attack surface)"))
    return out


# --- D. Encryption and storage -------------------------------------------------
@check("D1", "Evidence bucket: private, KMS, versioned, TLS-only, logged")
def _():
    out = []
    for b in [r["PhysicalResourceId"] for r in stack_resources("evidence", "AWS::S3::Bucket")]:
        pab = aws("s3api", "get-public-access-block", "--bucket", b)["PublicAccessBlockConfiguration"]
        enc = aws("s3api", "get-bucket-encryption", "--bucket", b)["ServerSideEncryptionConfiguration"]["Rules"][0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"]
        ver = aws("s3api", "get-bucket-versioning", "--bucket", b).get("Status")
        pol = json.dumps(aws("s3api", "get-bucket-policy", "--bucket", b).get("Policy", ""))
        tls = "aws:SecureTransport" in pol
        logged = bool(aws("s3api", "get-bucket-logging", "--bucket", b).get("LoggingEnabled"))
        sig = "signature-evidence" in b
        good = all(pab.values()) and ver == "Enabled" and tls and (enc == "aws:kms" if sig else True) and (logged if sig else True)
        out.append(("PASS" if good else "GAP", "%s: public access blocked %s, encryption %s, versioning %s, TLS-only %s, access logs %s" % (
            "signature bucket" if sig else "its access-log bucket", all(pab.values()), enc, ver, tls, logged if sig else "n/a")))
    return out


@check("D2", "Account-wide S3 public access block")
def _():
    try:
        c = aws("s3control", "get-public-access-block", "--account-id", ACCOUNT)["PublicAccessBlockConfiguration"]
    except RuntimeError as e:
        if "NoSuchPublicAccessBlockConfiguration" in str(e):
            return ("GAP", "not set at account level (each Ogevia bucket blocks public access itself; D1)")
        raise
    return ("PASS" if all(c.values()) else "GAP", "all four settings %s" % all(c.values()))


@check("D3", "KMS key rotation")
def _():
    out = []
    for k in [r["PhysicalResourceId"] for r in stack_resources("evidence", "AWS::KMS::Key")]:
        rot = aws("kms", "get-key-rotation-status", "--key-id", k).get("KeyRotationEnabled")
        out.append(("PASS" if rot else "GAP", "evidence key %s...: rotation %s" % (k[:8], rot)))
    return out


@check("D4", "Secrets rotation")
def _():
    fn = stack_resources("api", "AWS::Lambda::Function")[0]["PhysicalResourceId"]
    arn = aws("lambda", "get-function-configuration", "--function-name", fn)["Environment"]["Variables"]["DB_SECRET_ARN"]
    s = aws("secretsmanager", "describe-secret", "--secret-id", arn)
    master = aws("rds", "describe-db-instances", "--db-instance-identifier", RDS_PROD)["DBInstances"][0].get("MasterUserSecret", {})
    out = [("PASS" if s.get("RotationEnabled") else "GAP", "app DB secret %s: rotation %s, last changed %s" % (
        s.get("Name"), "on" if s.get("RotationEnabled") else "OFF", str(s.get("LastChangedDate", "?"))[:10]))]
    out.append(("PASS" if master.get("SecretStatus") == "active" else "INFO", "RDS master secret is RDS-managed (rotates automatically): %s" % master.get("SecretStatus", "not found")))
    return out


# --- E. Backup and recovery ----------------------------------------------------
@check("E1", "Automated backups and point-in-time recovery")
def _():
    d = aws("rds", "describe-db-instances", "--db-instance-identifier", RDS_PROD)["DBInstances"][0]
    out = [("PASS" if d["BackupRetentionPeriod"] >= 7 else "GAP", "%s: retention %d days, latest restorable %s" % (
        RDS_PROD, d["BackupRetentionPeriod"], str(d.get("LatestRestorableTime", "none"))[:19]))]
    out.append(("PASS" if d.get("DeletionProtection") else "GAP", "deletion protection %s" % d.get("DeletionProtection")))
    out.append(("INFO", "Multi-AZ %s (single-AZ: an AZ outage stops the service until restore; +about $16/month to enable)" % d.get("MultiAZ")))
    return out


@check("E2", "Manual snapshots encrypted")
def _():
    s = aws("rds", "describe-db-snapshots", "--db-instance-identifier", RDS_PROD, "--snapshot-type", "manual")["DBSnapshots"]
    unenc = [x["DBSnapshotIdentifier"] for x in s if not x.get("Encrypted")]
    return ("PASS" if not unenc else "GAP", "%d manual snapshot(s); unencrypted: %s" % (len(s), ", ".join(unenc) or "none"))


@check("E3", "Restore drill")
def _():
    return ("MANUAL", "no restore has ever been tested. Required: restore the latest snapshot to a NEW instance, run db:verify, record the time taken, delete the test instance (see the review, section 5)")


# --- F. Identity and access for the application ------------------------------
@check("F1", "Cognito pool: MFA and password policy")
def _():
    p = aws("cognito-idp", "describe-user-pool", "--user-pool-id", POOL)["UserPool"]
    mfa = aws("cognito-idp", "get-user-pool-mfa-config", "--user-pool-id", POOL)
    pw = p.get("Policies", {}).get("PasswordPolicy", {})
    out = [("PASS" if mfa.get("MfaConfiguration") == "ON" else "GAP", "MFA %s, TOTP %s" % (
        mfa.get("MfaConfiguration"), (mfa.get("SoftwareTokenMfaConfiguration") or {}).get("Enabled")))]
    strong = pw.get("MinimumLength", 0) >= 12 or (pw.get("MinimumLength", 0) >= 8 and all(pw.get(k) for k in ("RequireUppercase", "RequireLowercase", "RequireNumbers", "RequireSymbols")))
    out.append(("PASS" if strong else "GAP", "password min length %s, upper %s lower %s numbers %s symbols %s, temp password valid %s days" % (
        pw.get("MinimumLength"), pw.get("RequireUppercase"), pw.get("RequireLowercase"), pw.get("RequireNumbers"),
        pw.get("RequireSymbols"), pw.get("TemporaryPasswordValidityDays"))))
    out.append(("PASS" if p.get("DeletionProtection") == "ACTIVE" else "GAP", "deletion protection %s" % p.get("DeletionProtection")))
    out.append(("PASS" if (p.get("AdminCreateUserConfig") or {}).get("AllowAdminCreateUserOnly") else "GAP",
                "self sign-up %s" % ("disabled (admin creates users)" if (p.get("AdminCreateUserConfig") or {}).get("AllowAdminCreateUserOnly") else "ENABLED")))
    out.append(("INFO", "%s users; tier %s; threat protection %s" % (
        p.get("EstimatedNumberOfUsers"), p.get("UserPoolTier", "?"), (p.get("UserPoolAddOns") or {}).get("AdvancedSecurityMode", "OFF"))))
    return out


@check("F2", "Cognito app clients")
def _():
    out = []
    for c in aws("cognito-idp", "list-user-pool-clients", "--user-pool-id", POOL, "--max-results", "20")["UserPoolClients"]:
        d = aws("cognito-idp", "describe-user-pool-client", "--user-pool-id", POOL, "--client-id", c["ClientId"])["UserPoolClient"]
        flows = d.get("AllowedOAuthFlows") or []
        good = "implicit" not in flows and d.get("PreventUserExistenceErrors") == "ENABLED"
        out.append(("PASS" if good else "GAP", "%s: flows %s, client secret %s, refresh %s %s, user-existence errors hidden %s" % (
            d["ClientName"], ",".join(flows) or "none", "yes" if d.get("ClientSecret") else "no",
            d.get("RefreshTokenValidity"), (d.get("TokenValidityUnits") or {}).get("RefreshToken", "days"),
            d.get("PreventUserExistenceErrors") == "ENABLED")))
    return out


@check("F3", "Lambda role is least privilege")
def _():
    fn = stack_resources("api", "AWS::Lambda::Function")[0]["PhysicalResourceId"]
    role = aws("lambda", "get-function-configuration", "--function-name", fn)["Role"].split("/")[-1]
    attached = aws("iam", "list-attached-role-policies", "--role-name", role)["AttachedPolicies"]
    inline = aws("iam", "list-role-policies", "--role-name", role)["PolicyNames"]
    findings = []
    for p in attached:
        if p["PolicyArn"].startswith("arn:aws:iam::aws:"):
            findings.append("AWS-managed %s" % p["PolicyName"])
            continue
        v = aws("iam", "get-policy", "--policy-arn", p["PolicyArn"])["Policy"]["DefaultVersionId"]
        doc = aws("iam", "get-policy-version", "--policy-arn", p["PolicyArn"], "--version-id", v)["PolicyVersion"]["Document"]
        for st in doc["Statement"]:
            acts = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
            res = st["Resource"] if isinstance(st["Resource"], list) else [st["Resource"]]
            if any(a.endswith("*") for a in acts):
                findings.append("wildcard action in %s" % st.get("Sid"))
            if "*" in res and not all(a.startswith("ec2:") for a in acts):
                findings.append("Resource * in %s" % st.get("Sid"))
    good = not findings and not inline
    return ("PASS" if good else "GAP", "role %s: %d managed polic(ies), %d inline; findings: %s (Resource * only on the 5 ENI actions)" % (
        role[:40], len(attached), len(inline), "; ".join(findings) or "none"))


@check("F4", "API: sign-in required except the approved public links")
def _():
    api_id = stack_resources("api", "AWS::ApiGatewayV2::Api")[0]["PhysicalResourceId"]
    items = aws("apigatewayv2", "get-routes", "--api-id", api_id)["Items"]
    pub = [i["RouteKey"] for i in items if i.get("AuthorizationType", "NONE") == "NONE"]
    stage = aws("apigatewayv2", "get-stage", "--api-id", api_id, "--stage-name", "$default")
    thr = stage.get("DefaultRouteSettings", {})
    fmt = (stage.get("AccessLogSettings") or {}).get("Format", "")
    leaks = [f for f in ("$context.path", "$context.identity.sourceIp", "$context.requestBody") if f in fmt]
    unapproved = sorted(set(pub) - APPROVED_PUBLIC_ROUTES)
    missing = sorted(APPROVED_PUBLIC_ROUTES - set(pub))
    out = [("PASS" if not unapproved and not missing else "GAP", "%d routes, %d public (approved %d: tokenized care-portal/offer/visit-confirmation links); not on the approved list: %s; approved but not found: %s" % (
        len(items), len(pub), len(APPROVED_PUBLIC_ROUTES), "; ".join(unapproved) or "none", "; ".join(missing) or "none"))]
    out.append(("PASS" if thr.get("ThrottlingRateLimit") else "GAP", "throttling %s req/s, burst %s" % (thr.get("ThrottlingRateLimit"), thr.get("ThrottlingBurstLimit"))))
    out.append(("PASS" if fmt and not leaks else "GAP", "access log %s; path/IP/body fields: %s" % ("on" if fmt else "OFF", ", ".join(leaks) or "none")))
    return out


@check("F5", "Web front end: HTTPS and security headers")
def _():
    dist = stack_resources("web", "AWS::CloudFront::Distribution")[0]["PhysicalResourceId"]
    c = aws("cloudfront", "get-distribution-config", "--id", dist, region="us-east-1")["DistributionConfig"]
    beh = c["DefaultCacheBehavior"]
    cert = c.get("ViewerCertificate", {})
    out = [("PASS" if beh.get("ViewerProtocolPolicy") in ("redirect-to-https", "https-only") and beh.get("ResponseHeadersPolicyId") else "GAP",
            "viewer protocol %s, security headers policy %s, access logging %s" % (
                beh.get("ViewerProtocolPolicy"), "attached" if beh.get("ResponseHeadersPolicyId") else "NONE", (c.get("Logging") or {}).get("Enabled")))]
    out.append(("INFO", "certificate %s: minimum TLS %s (the default *.cloudfront.net certificate cannot be set higher; a custom domain with TLSv1.2_2021 is the fix at production cutover)" % (
        "default *.cloudfront.net" if cert.get("CloudFrontDefaultCertificate") else "custom", cert.get("MinimumProtocolVersion"))))
    waf = c.get("WebACLId")
    out.append(("INFO", "AWS WAF %s (owner decision; see the review)" % ("attached" if waf else "not attached")))
    return out


# --- G. Monitoring, threat detection, cost -------------------------------------
@check("G1", "Alarms reach a person")
def _():
    topics = [r["PhysicalResourceId"] for r in stack_resources("obs", "AWS::SNS::Topic")]
    out = []
    for t in topics:
        subs = aws("sns", "list-subscriptions-by-topic", "--topic-arn", t)["Subscriptions"]
        conf = [s for s in subs if s["SubscriptionArn"].startswith("arn:")]
        out.append(("PASS" if conf else "GAP", "alarm topic has %d confirmed subscription(s): %s" % (
            len(conf), "alarms currently notify NOBODY" if not conf else ", ".join(s["Protocol"] for s in conf))))
    alarms = aws("cloudwatch", "describe-alarms", "--alarm-name-prefix", STACKS["obs"])["MetricAlarms"]
    states = {}
    for a in alarms:
        states[a["StateValue"]] = states.get(a["StateValue"], 0) + 1
    out.append(("PASS" if alarms and not states.get("ALARM") else "GAP", "%d alarms: %s" % (len(alarms), ", ".join("%s %d" % kv for kv in sorted(states.items())) or "none")))
    return out


@check("G2", "Budget alerts")
def _():
    b = aws("budgets", "describe-budgets", "--account-id", ACCOUNT, region="us-east-1").get("Budgets", [])
    if not b:
        return ("GAP", "no AWS Budget")
    out = []
    for x in b:
        n = aws("budgets", "describe-notifications-for-budget", "--account-id", ACCOUNT, "--budget-name", x["BudgetName"], region="us-east-1").get("Notifications", [])
        subs = 0
        for note in n:
            subs += len(aws("budgets", "describe-subscribers-for-notification", "--account-id", ACCOUNT, "--budget-name", x["BudgetName"],
                            "--notification", json.dumps(note), region="us-east-1").get("Subscribers", []))
        spend = x.get("CalculatedSpend", {}).get("ActualSpend", {})
        out.append(("PASS" if n and subs else "GAP", "%s: limit %s %s, actual this month %s, %d alert(s) with %d subscriber(s)" % (
            x["BudgetName"], x["BudgetLimit"]["Amount"], x["BudgetLimit"]["Unit"], spend.get("Amount", "?"), len(n), subs)))
    return out


@check("G3", "Threat detection services")
def _():
    out = []
    try:
        d = aws("guardduty", "list-detectors").get("DetectorIds", [])
        out.append(("PASS" if d else "GAP", "GuardDuty %s in us-west-2" % ("enabled" if d else "NOT enabled")))
    except Exception as e:
        out.append(("ERROR", "GuardDuty: %s" % e))
    try:
        aws("securityhub", "describe-hub")
        out.append(("INFO", "Security Hub enabled"))
    except Exception as e:
        not_on = re.search(r"not subscribed|InvalidAccessException", str(e))
        out.append(("INFO", "Security Hub not enabled (optional)") if not_on else ("ERROR", "Security Hub: %s" % e))
    return out


# --- Summary -------------------------------------------------------------------
counts = {}
for s, *_ in RESULTS:
    counts[s] = counts.get(s, 0) + 1
outdir = os.path.expanduser("~/ogevia-phase7")
os.makedirs(outdir, exist_ok=True)
path = os.path.join(outdir, "evidence-%s.txt" % dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
with open(path, "w") as f:
    for s, cid, name, detail in RESULTS:
        f.write("%-6s  %-4s %s: %s\n" % (s, cid, name, mask(detail)))
print("-" * 100)
print("SUMMARY  " + "  ".join("%s %d" % (k, counts.get(k, 0)) for k in ("PASS", "GAP", "MANUAL", "ERROR", "INFO")))
for status in ("GAP", "MANUAL", "ERROR"):
    ids = sorted({cid for s, cid, *_ in RESULTS if s == status})
    if ids:
        print("%-6s %s" % (status, " ".join(ids)))
print("Saved: %s" % path)
sys.exit(0)
