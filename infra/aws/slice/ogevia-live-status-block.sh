export PATH="$HOME/.local/bin:$PATH"
mkdir -p ~/ogevia-live-status
cat > ~/ogevia-live-status/phase7_evidence.py <<'OGEVIAFILE'
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
STACKS = {
    "evidence": "Ogevia-prod-EvidenceStorage",
    "egress": "Ogevia-prod-NetworkEgress",
    "web": "Ogevia-prod-WebHosting",
    "api": "Ogevia-prod-ServiceVerificationApi",
    "obs": "Ogevia-prod-Observability",
}
APPROVED_PUBLIC_ROUTES = 8

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
    out = [("PASS" if len(pub) == APPROVED_PUBLIC_ROUTES else "GAP", "%d routes, %d public (approved %d: tokenized care-portal/offer links)" % (len(items), len(pub), APPROVED_PUBLIC_ROUTES))]
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
OGEVIAFILE
cat > ~/ogevia-live-status/owner-access-check.sh <<'OGEVIAFILE'
#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: owner / manager / finance access check. READ-ONLY FIRST.
#   Part A (read-only, no prompt): Cognito sign-ins in the TEST pool, the
#     account to check (default admin.ogevia@gmail.com), and which API build
#     is live.
#   Part B (needs READ-DB): agency memberships, roles and effective
#     permissions from the TEST database, in a READ ONLY transaction. The only
#     change is temporary: the app security group is attached to the admin
#     host for the tunnel and its original groups are restored on exit
#     (verified).
#   Part C (needs OWNER, shown in full first): the smallest owner fix, using
#     an EXISTING Cognito identity (never creates a sign-in). One transaction:
#     app user row if missing, an organization_owner membership in the pilot
#     agency, and an audit event. Writes an exact rollback file first.
# Prints: Account | Role | Can view | Can approve | Missing access.
# Never prints passwords or tokens. Never touches production, Netlify, Supabase.
# Log: ~/ogevia-access/access-<UTC>.log
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
CHECK_EMAIL="${OGEVIA_CHECK_EMAIL:-admin.ogevia@gmail.com}"
ORG_SLUG="${OGEVIA_ORG_SLUG:-scs-pilot-synthetic}"
ACCOUNT=300094796789
POOL=us-west-2_849AYz5J7
RDS_ID=ogevia-prod-postgres
DB=ogevia_sv_test
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
PORT=${OGEVIA_ACCESS_LOCAL_PORT:-15435}   # OGEVIA_ACCESS_* overrides exist only for local rehearsal
OUT="$HOME/ogevia-access"; mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ); LOG="$OUT/access-$STAMP.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP=start; IID=""; BASE_SGS=""; TUN=""
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== $1"; }
cleanup() {
  local rc=$?
  [[ -n "$TUN" ]] && kill "$TUN" 2>/dev/null
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD
  if [[ -n "$IID" && -n "$BASE_SGS" ]]; then
    local now
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    if [[ "$now" != "$BASE_SGS" ]]; then
      # shellcheck disable=SC2086
      aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS && say "Admin host security groups restored: $BASE_SGS" \
        || say "WARNING: restore the admin host's security groups to $BASE_SGS (EC2 console)"
    fi
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    [[ "$now" == "$BASE_SGS" ]] && say "Verified: admin host groups are the original ($now)." || say "WARNING: admin host groups are $now (expected $BASE_SGS)"
  fi
  [[ $rc != 0 && -z "${STOPPED:-}" && -z "${DONE:-}" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). Log: $LOG"
}
trap cleanup EXIT
stop() { STOPPED=1; say "STOP in \"$STEP\": $*"; say "Log: $LOG"; exit 1; }

step "A1 Identity"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" && "$ARN" == *AdministratorAccess* ]] || stop "needs account $ACCOUNT with AdministratorAccess (current: $ARN)"
echo "Account $ACCOUNT, us-west-2: OK"

step "A2 Cognito sign-ins in the TEST pool (no passwords or tokens exist in this output)"
USERS="$OUT/cognito-users-$STAMP.json"
aws cognito-idp list-users --user-pool-id "$POOL" --output json > "$USERS" 2>"$OUT/err" || stop "cannot list Cognito users: $(tail -1 "$OUT/err")"
jq -r '.Users[] | [ (.Attributes[]? | select(.Name=="email") | .Value) // "(no email)", .UserStatus, (if .Enabled then "enabled" else "DISABLED" end), (.Attributes[]? | select(.Name=="sub") | .Value) ] | @tsv' "$USERS" \
  | sort | awk -F'\t' '{printf "  %-42s %-22s %-9s sub %s\n", $1, $2, $3, substr($4,1,8)"..."}'
echo "  total: $(jq '.Users | length' "$USERS")"
CHECK_SUB=$(jq -r --arg e "$CHECK_EMAIL" '.Users[] | select(any(.Attributes[]?; .Name=="email" and (.Value|ascii_downcase)==($e|ascii_downcase))) | (.Attributes[] | select(.Name=="sub") | .Value)' "$USERS" | head -1)
if [[ -n "$CHECK_SUB" ]]; then
  CG_GROUPS=$(aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username "$CHECK_SUB" --query 'Groups[].GroupName' --output text 2>/dev/null)
  echo "$CHECK_EMAIL: exists in Cognito (sub ${CHECK_SUB:0:8}...); Cognito groups: ${CG_GROUPS:-none} (Ogevia roles come from the database, not Cognito groups)"
else
  echo "$CHECK_EMAIL: NOT in the TEST Cognito pool"
fi

step "A3 Which API build is live"
FN=$(aws cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text 2>/dev/null)
LIVE_SHA=$(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text 2>/dev/null)
CAP_SHA=$(jq -r .CodeSha256 "$HOME/ogevia-pilot-run/rollback/lambda.json" 2>/dev/null)
API_ID=$(aws cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text 2>/dev/null)
CLOSE=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /v1/visits/{visitId}/close'] | length(@)" --output text 2>/dev/null)
if [[ -n "$CAP_SHA" && "$LIVE_SHA" == "$CAP_SHA" ]]; then BUILD="the October 2 build (pilot NOT deployed)"; elif [[ "$CLOSE" == 1 ]]; then BUILD="the pilot build (close route live)"; else BUILD="unknown build"; fi
echo "Lambda CodeSha256 ${LIVE_SHA:0:12}... -> $BUILD"
echo "Billing routes in the live API: $(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?contains(RouteKey,'billing')].RouteKey" --output text 2>/dev/null | tr '\t' ' ')"

step "B Database memberships and permissions (read-only queries)"
cat <<EOF
To read memberships the script needs a short database window:
  - attach $APP_SG to the admin host $ADMIN_TAG (temporary), open an SSM tunnel,
  - run SELECT queries in a READ ONLY transaction on $DB,
  - restore the admin host's original security groups and verify them.
Nothing in the database changes in this part.
EOF
read -r -p "Type READ-DB to run part B (anything else stops here): " ans
if [[ "$ans" != READ-DB ]]; then STOPPED=1; say "Stopped after the read-only part A (no database read). Log: $LOG"; exit 0; fi
for t in jq psql session-manager-plugin; do
  command -v "$t" >/dev/null && continue
  case "$t" in
    psql) sudo dnf install -y -q postgresql15 >/dev/null || stop "could not install psql" ;;
    session-manager-plugin) sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null || stop "could not install session-manager-plugin" ;;
    jq) stop "jq is missing" ;;
  esac
done
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $RDS_ID"
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == i-* ]] || { IID=""; stop "admin host $ADMIN_TAG is not running: start it in EC2, then paste again"; }
NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
BASE_SGS=$(tr -s ' \t' '\n' <<<"$NOW_SGS" | grep -v "^$APP_SG$" | sort | xargs)
[[ -n "$BASE_SGS" ]] || stop "cannot determine the admin host's own security group"
# shellcheck disable=SC2086
grep -qw "$APP_SG" <<<"$NOW_SGS" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS "$APP_SG" || stop "could not attach $APP_SG"
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$(jq -r .Endpoint.Address <<<"$RDS"),portNumber=5432,localPortNumber=$PORT" >/dev/null &
TUN=$!
for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 2; done
(echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null || stop "SSM tunnel did not open"
SEC=$(aws secretsmanager get-secret-value --secret-id "$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")" --query SecretString --output text) || stop "cannot read the master secret"
export PGHOST=127.0.0.1 PGPORT=$PORT PGSSLMODE=${OGEVIA_ACCESS_PGSSLMODE:-require} PGCONNECT_TIMEOUT=15 PGDATABASE=$DB
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
unset SEC
# Quiet (-q): no command tags such as "SET" in the output, only result rows.
RO() { psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "set default_transaction_read_only = on" -c "$1"; }
LEDGER=$(RO "select count(*) || ' migrations, latest ' || max(version) from ogevia_meta.schema_migrations") || stop "cannot query $DB"
echo "Migration ledger: $LEDGER"
MEM="$OUT/memberships-$STAMP.tsv"
RO "select o.slug, coalesce(u.cognito_sub,''), coalesce(u.display_name,''), u.status, m.role, m.status,
       coalesce((select string_agg(rp.permission_key, ',' order by rp.permission_key) from ogevia.role_permissions rp where rp.role = m.role), '')
    from ogevia.organization_memberships m
    join ogevia.organizations o on o.id = m.organization_id
    join ogevia.app_users u on u.id = m.user_id
    order by o.slug, m.role, u.display_name" > "$MEM" || stop "cannot read memberships"
ORGS=$(RO "select slug || ' (' || display_name || ', ' || status || ')' from ogevia.organizations order by slug")
echo "Agencies in $DB:"; sed 's/^/  /' <<<"$ORGS"

step "B2 Access table"
python3 - "$USERS" "$MEM" "$ORG_SLUG" <<'PY' | tee "$OUT/access-table-$STAMP.txt"
import json, sys
users, mem, focus = sys.argv[1], sys.argv[2], sys.argv[3]
email = {}
for u in json.load(open(users))["Users"]:
    a = {x["Name"]: x["Value"] for x in u.get("Attributes", [])}
    email[a.get("sub", "")] = (a.get("email", "(no email)"), u.get("UserStatus"), u.get("Enabled"))
rows = [l.rstrip("\n").split("\t") for l in open(mem) if l.strip()]
VIEW = [("visits.read", "visit records"), ("billing.visits.read", "billing review (no $)"), ("authorizations.read", "authorizations"),
        ("care_requests.read", "care requests")]
print(" | ".join(("Account", "Role (agency)", "Can view", "Can approve", "Missing access")))
print("-" * 200)
owners = {}
for org, sub, name, ustatus, role, mstatus, perms in rows:
    p = set(filter(None, perms.split(",")))
    e, cstatus, enabled = email.get(sub, ("(no Cognito sign-in)", None, None))
    if role == "organization_owner" and mstatus == "active":
        owners.setdefault(org, []).append(e)
    view = ", ".join(v for k, v in VIEW if k in p) or ("own assigned visits" if role == "caregiver" else "nothing")
    if "billing.approve" in p:
        approve = "permission granted, but AWS has NO approval operation"
    elif "visits.manage" in p:
        approve = "visit corrections/close-outs only"
    else:
        approve = "nothing"
    missing = []
    if mstatus != "active": missing.append("membership " + mstatus)
    if cstatus and cstatus != "CONFIRMED": missing.append("sign-in " + cstatus)
    if enabled is False: missing.append("sign-in disabled")
    if role in ("organization_owner", "manager"): missing.append("finance (no billing approval/export/revenue in AWS)")
    print(" | ".join((e, "%s (%s)" % (role, org), view, approve, "; ".join(missing) or "none")))
in_db = {r[1] for r in rows}
for sub, (e, cstatus, enabled) in sorted(email.items(), key=lambda x: x[1][0]):
    if sub not in in_db:
        print(" | ".join((e, "no agency membership", "nothing (signs in, no agency)", "nothing", "membership")))
print()
for org in sorted({r[0] for r in rows}):
    print("Owner of %s: %s" % (org, ", ".join(owners.get(org, [])) or "NONE"))
PY

step "C Owner fix for $ORG_SLUG (shown first; applied only with OWNER)"
OWNER_NOW=$(RO "select count(*) from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' and m.role = 'organization_owner' and m.status = 'active'")
ORG_ID=$(RO "select id from ogevia.organizations where slug = '$ORG_SLUG'")
[[ "$OWNER_NOW" =~ ^[0-9]+$ ]] || stop "unexpected owner count '$OWNER_NOW'"
[[ -z "$ORG_ID" || "$ORG_ID" =~ ^[0-9a-f-]{36}$ ]] || stop "unexpected agency id '$ORG_ID'"
if [[ -z "$ORG_ID" ]]; then STOPPED=1; say "Agency $ORG_SLUG does not exist in $DB: no owner fix proposed (send this to Claude)."; exit 0; fi
if [[ "$OWNER_NOW" != 0 ]]; then DONE=1; say "$ORG_SLUG already has an active owner: no change proposed."; exit 0; fi
if [[ -z "$CHECK_SUB" ]]; then STOPPED=1; say "$ORG_SLUG has NO owner, and $CHECK_EMAIL has no TEST sign-in. No account will be created. Tell Claude which EXISTING sign-in should be the owner."; exit 0; fi
CUR=$(RO "select coalesce(m.role::text, 'none') || '|' || coalesce(m.status::text, '-') || '|' || (u.id is not null)::text
          from (select 1) x left join ogevia.app_users u on u.cognito_sub = '$CHECK_SUB'
          left join ogevia.organization_memberships m on m.user_id = u.id and m.organization_id = '$ORG_ID'")
CUR_ROLE=${CUR%%|*}; REST=${CUR#*|}; CUR_STATUS=${REST%%|*}; HAS_USER=${REST#*|}
[[ "$CUR_ROLE" =~ ^[a-z_]+$ && "$HAS_USER" =~ ^(true|false)$ ]] || stop "unexpected membership read '$CUR'"
PILOT_MANAGER=$(bash -c 'source "$1" 2>/dev/null; printf %s "${M_EMAIL:-}"' _ "$HOME/ogevia-pilot-run/inputs.env")
cat <<EOF

PROPOSED CHANGE (TEST database $DB only; nothing else):
  identity: $CHECK_EMAIL (existing Cognito sign-in, sub ${CHECK_SUB:0:8}...). No sign-in is created.
  agency:   $ORG_SLUG
  now:      role $CUR_ROLE (membership $CUR_STATUS); app user row $( [[ "$HAS_USER" == true ]] && echo exists || echo "missing (will be created, linked to this sub)")
  after:    role organization_owner, membership active
  effective owner permissions: visits.read, visits.manage, authorizations.read, authorizations.update,
                               billing.visits.read, billing.approve
  audit:    one audit_events row (membership.owner_granted, before/after state, reason)
  rollback: written to $OUT/owner-rollback-$STAMP.sql before anything changes
EOF
if [[ "$CUR_ROLE" == manager && -n "$PILOT_MANAGER" && "${PILOT_MANAGER,,}" == "${CHECK_EMAIL,,}" ]]; then
  echo "  WARNING: $CHECK_EMAIL is also the pilot MANAGER sign-in. Promoting it leaves the pilot with no manager-only"
  echo "           account to test manager limits. Consider a different existing identity instead (stop and ask Claude)."
fi
echo "  Note: billing approval itself does not exist in the AWS build yet; owner access adds no approval screen."
read -r -p "Type OWNER to apply exactly this change (anything else leaves it unapplied): " ans
[[ "$ans" == OWNER ]] || { DONE=1; say "Owner fix NOT applied (as chosen). Log: $LOG"; exit 0; }
RB="$OUT/owner-rollback-$STAMP.sql"
if [[ "$CUR_ROLE" == none ]]; then
  RB_DESC="remove the membership that did not exist before"
  RB_STMT="delete from ogevia.organization_memberships where id = v_mid"
else
  RB_DESC="restore the previous role ($CUR_ROLE) and status ($CUR_STATUS)"
  RB_STMT="update ogevia.organization_memberships set role = '$CUR_ROLE', status = '$CUR_STATUS', updated_at = now() where id = v_mid"
fi
# The rollback is audited too, so the trail never ends at "owner granted".
cat > "$RB" <<RBSQL
-- Rollback of owner grant $STAMP: $RB_DESC.
begin;
set local role ogevia_owner;
do \$\$
declare v_mid uuid; v_before jsonb; v_after jsonb;
begin
  select m.id, to_jsonb(m) into v_mid, v_before from ogevia.organization_memberships m
   where m.organization_id = '$ORG_ID' and m.user_id = (select id from ogevia.app_users where cognito_sub = '$CHECK_SUB');
  if v_mid is null then raise exception 'membership not found; nothing rolled back'; end if;
  $RB_STMT;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values ('$ORG_ID', null, 'membership.owner_grant_rolled_back', 'organization_membership', v_mid, 'Rollback of owner grant $STAMP', v_before, v_after);
end \$\$;
commit;
RBSQL
echo "Rollback saved: $RB"
NAME=$(jq -r --arg s "$CHECK_SUB" '.Users[] | select(any(.Attributes[]?; .Name=="sub" and .Value==$s)) | ((.Attributes[] | select(.Name=="name") | .Value) // "Owner")' "$USERS" | head -1)
psql -X -v ON_ERROR_STOP=1 -At \
  -v sub="$CHECK_SUB" -v org="$ORG_SLUG" -v name="${NAME:-Owner}" -v reason="Owner access for $CHECK_EMAIL (owner request $STAMP)" <<'SQL' || stop "the owner change failed and was rolled back (error above)"
begin;
set local role ogevia_owner;
\o /dev/null
select set_config('ogevia.fix_sub', :'sub', true), set_config('ogevia.fix_org', :'org', true),
       set_config('ogevia.fix_name', :'name', true), set_config('ogevia.fix_reason', :'reason', true);
\o
do $$
declare v_org uuid; v_user uuid; v_mid uuid; v_before jsonb; v_after jsonb;
begin
  select id into v_org from ogevia.organizations where slug = current_setting('ogevia.fix_org');
  if v_org is null then raise exception 'agency not found'; end if;
  insert into ogevia.app_users (cognito_sub, display_name) values (current_setting('ogevia.fix_sub'), current_setting('ogevia.fix_name'))
  on conflict (cognito_sub) do nothing;
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.fix_sub');
  select to_jsonb(m) into v_before from ogevia.organization_memberships m where m.organization_id = v_org and m.user_id = v_user;
  insert into ogevia.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_user, 'organization_owner', 'active')
  on conflict (organization_id, user_id) do update set role = 'organization_owner', status = 'active', updated_at = now()
  returning id into v_mid;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values (v_org, null, 'membership.owner_granted', 'organization_membership', v_mid, current_setting('ogevia.fix_reason'), v_before, v_after);
end $$;
commit;
SQL
AFTER=$(RO "select m.role || ' ' || m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '$CHECK_SUB' and m.organization_id = '$ORG_ID'")
[[ "$AFTER" == "organization_owner active" ]] || stop "read-back is '$AFTER', not 'organization_owner active'; roll back with: psql ... -f $RB"
echo "Applied and read back: $CHECK_EMAIL is organization_owner (active) of $ORG_SLUG. Audit event written. Rollback file: $RB"
DONE=1
say "Done. Log: $LOG"
OGEVIAFILE
cat > ~/ogevia-live-status/live-status-check.sh <<'OGEVIAFILE'
#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: independent live status (READ-ONLY), in this order:
#   1. Phase 7 security settings (phase7_evidence.py): encryption, private DB,
#      IAM, CloudTrail, alarms and retention, backups, S3 public access,
#      Cognito MFA, budgets. Describe/get/list calls only.
#   2. Deployment and access (owner-access-check.sh):
#      part A, no prompt: Cognito sign-ins and which API build is live;
#      part B, only if you type READ-DB: migration ledger (expects 0018 after
#      the pilot), agency memberships, roles and effective permissions, in a
#      READ ONLY transaction. The app security group is attached to the admin
#      host for the tunnel and removed again (verified);
#      part C, only if you type OWNER: the owner fix, shown in full first.
# Never prints passwords, tokens or secret values. Never touches production,
# Netlify or Supabase.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== 1/2 Security settings (read-only) ==="
python3 "$HERE/phase7_evidence.py" || echo "Security evidence ended with exit $? (see the lines above)."
echo
echo "=== 2/2 Deployment, sign-ins and owner access ==="
bash "$HERE/owner-access-check.sh"
OGEVIAFILE
if (cd ~/ogevia-live-status && sha256sum -c --quiet <<SUMS
8377ecdc675b303961702964a25f4e4bbb080733fb1f07b9c823b917d7a9a926  phase7_evidence.py
ae90de8be38f8fe3fb4ff807395a3ea298f7e2414c85428413b62f8ad09e360b  owner-access-check.sh
830851f7cfad477df49770b488c787523aad9e9e0c4bfeef28444ba904e309fb  live-status-check.sh
SUMS
); then bash ~/ogevia-live-status/live-status-check.sh; else echo "STOP: the files did not arrive complete (checksum). Paste the whole block again; nothing ran."; fi
