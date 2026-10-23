#!/usr/bin/env bash
# Ogevia permanent URLs: ACM certificate, CloudFront alternate domain names, Route53 aliases.
# PROPOSED / NOT RUN. Run from AWS CloudShell or a terminal with ACM, CloudFront and Route53 write access.
# Touches nothing else: no Cognito, databases, tenants, subscriber data or onboarding.
#
#   ./ogevia-custom-domains.sh            # dry run: read-only checks, prints what would change
#   APPLY=1 ./ogevia-custom-domains.sh    # makes the changes
#   APPLY=1 FORCE=1 ...                   # also allows replacing an existing DNS record that points elsewhere
set -euo pipefail

PROD_CF=d3l4psdkokkvnb.cloudfront.net
DEMO_CF=d2xumch5w0izfg.cloudfront.net
ROOT=ogevia.com
NAMES=(app.$ROOT admin.$ROOT demo.$ROOT)
CF_ZONE=Z2FDTNDATAQYW2          # fixed hosted zone ID for all CloudFront alias targets
APPLY=${APPLY:-0}; FORCE=${FORCE:-0}
run() { if [ "$APPLY" = 1 ]; then "$@"; else echo "[dry-run] $*"; fi; }

aws sts get-caller-identity --query Arn --output text

# --- locate zone and distributions (read-only) ---
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name $ROOT --query "HostedZones[?Name=='$ROOT.'].Id|[0]" --output text | sed 's#/hostedzone/##')
[ -n "$ZONE" ] && [ "$ZONE" != None ] || { echo "No public hosted zone for $ROOT in this account"; exit 1; }
dist_id() { aws cloudfront list-distributions --query "DistributionList.Items[?DomainName=='$1'].Id|[0]" --output text; }
PROD_ID=$(dist_id $PROD_CF); DEMO_ID=$(dist_id $DEMO_CF)
[ "$PROD_ID" != None ] && [ "$DEMO_ID" != None ] || { echo "Distribution not found (prod=$PROD_ID demo=$DEMO_ID)"; exit 1; }
echo "zone=$ZONE prod=$PROD_ID demo=$DEMO_ID"

# --- existing DNS records: abort if one points somewhere else ---
for n in "${NAMES[@]}"; do
  echo "== existing records for $n"
  aws route53 list-resource-record-sets --hosted-zone-id "$ZONE" \
    --query "ResourceRecordSets[?Name=='$n.']" --output json
done
EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE" \
  --query "ResourceRecordSets[?(Name=='app.$ROOT.' || Name=='admin.$ROOT.' || Name=='demo.$ROOT.') && AliasTarget.DNSName!=null && !contains(AliasTarget.DNSName,'cloudfront.net')] | length(@)" --output text)
OTHER=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE" \
  --query "ResourceRecordSets[?(Name=='app.$ROOT.' || Name=='admin.$ROOT.' || Name=='demo.$ROOT.') && AliasTarget==null] | length(@)" --output text)
if [ "$((EXISTING + OTHER))" -gt 0 ] && [ "$FORCE" != 1 ]; then
  echo "Existing non-CloudFront record(s) found above (live traffic may be moved). Review, then rerun with FORCE=1."; exit 2
fi

# --- 1. ACM certificate (us-east-1 is required for CloudFront) ---
CERT=$(aws acm list-certificates --region us-east-1 --certificate-statuses ISSUED PENDING_VALIDATION --output json |
  python3 -c "
import json,sys,subprocess
want=set('${NAMES[*]}'.split())
for c in json.load(sys.stdin)['CertificateSummaryList']:
    d=json.loads(subprocess.check_output(['aws','acm','describe-certificate','--region','us-east-1','--certificate-arn',c['CertificateArn']]))['Certificate']
    if set(d.get('SubjectAlternativeNames',[]))==want: print(c['CertificateArn']); break")
if [ -z "$CERT" ]; then
  CERT=$(run aws acm request-certificate --region us-east-1 --validation-method DNS \
    --domain-name "${NAMES[0]}" --subject-alternative-names "${NAMES[1]}" "${NAMES[2]}" --query CertificateArn --output text)
fi
echo "cert=${CERT:-<would be requested>}"
if [ "$APPLY" = 1 ]; then
  sleep 10
  aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output json |
  python3 -c "
import json,sys
seen={}
for r in json.load(sys.stdin):
    if r: seen[r['Name']]=r
ch=[{'Action':'UPSERT','ResourceRecordSet':{'Name':r['Name'],'Type':'CNAME','TTL':300,'ResourceRecords':[{'Value':r['Value']}]}} for r in seen.values()]
json.dump({'Changes':ch},open('/tmp/acm-validation.json','w'))"
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch file:///tmp/acm-validation.json
  aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT"
fi

# --- 2. CloudFront alternate domain names (merges with existing aliases) ---
set_aliases() { # id alias...
  local id=$1; shift
  aws cloudfront get-distribution-config --id "$id" > /tmp/cf-$id.json
  python3 - "$id" "$CERT" "$@" <<'PY'
import json,sys
id,cert,new=sys.argv[1],sys.argv[2],sys.argv[3:]
d=json.load(open(f'/tmp/cf-{id}.json')); c=d['DistributionConfig']
items=sorted(set(c.get('Aliases',{}).get('Items',[]))|set(new))
c['Aliases']={'Quantity':len(items),'Items':items}
c['ViewerCertificate']={'ACMCertificateArn':cert,'SSLSupportMethod':'sni-only','MinimumProtocolVersion':'TLSv1.2_2021'}
json.dump(c,open(f'/tmp/cf-{id}-new.json','w'))
open(f'/tmp/cf-{id}.etag','w').write(d['ETag'])
print(id,'aliases ->',items)
PY
  run aws cloudfront update-distribution --id "$id" --if-match "$(cat /tmp/cf-$id.etag)" \
    --distribution-config file:///tmp/cf-$id-new.json --query 'Distribution.Status' --output text
}
set_aliases "$PROD_ID" app.$ROOT admin.$ROOT
set_aliases "$DEMO_ID" demo.$ROOT

# --- 3. Route53 alias records ---
alias_batch() { # name target ipv6
  local out="" t
  for t in A $( [ "$3" = True ] && echo AAAA ); do
    out+="{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$1\",\"Type\":\"$t\",\"AliasTarget\":{\"HostedZoneId\":\"$CF_ZONE\",\"DNSName\":\"$2\",\"EvaluateTargetHealth\":false}}},"
  done
  echo "{\"Changes\":[${out%,}]}"
}
V6P=$(aws cloudfront get-distribution-config --id "$PROD_ID" --query 'DistributionConfig.IsIPV6Enabled' --output text)
V6D=$(aws cloudfront get-distribution-config --id "$DEMO_ID" --query 'DistributionConfig.IsIPV6Enabled' --output text)
for spec in "app.$ROOT $PROD_CF $V6P" "admin.$ROOT $PROD_CF $V6P" "demo.$ROOT $DEMO_CF $V6D"; do
  set -- $spec; B=$(alias_batch "$@"); echo "$B"
  run aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch "$B" --query 'ChangeInfo.Status' --output text
done

# --- 4. Validate ---
if [ "$APPLY" = 1 ]; then
  aws cloudfront wait distribution-deployed --id "$PROD_ID"; aws cloudfront wait distribution-deployed --id "$DEMO_ID"
  for n in "${NAMES[@]}"; do
    echo "== $n"; dig +short "$n" | head -2
    curl -sS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result} (0=ok)\n' "https://$n/"
    echo | openssl s_client -connect "$n:443" -servername "$n" 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName | head -4
  done
fi
