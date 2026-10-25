# Rollback: TEST web release

Scope: the TEST site's web files only. The database, API, Cognito, `config.json` and PROD are not involved, and a rollback never changes them.

## When to roll back
Any stop condition in `PHASE_C_AUTHORIZATION_STATEMENT.md`: the banner "TEST — synthetic data only" is missing on any page (SMK-07), sign-in fails, a console error on a core screen, `verify` fails, or the owner says stop. Rolling back is pre-authorized in the statement for TEST.

## What rollback does
`capture` (run before `publish`) copies the whole current TEST site to `~/ogevia-test-web-release-d82fefc/rollback/web/` and records the `index.html` checksum, the `config.json` checksum and the bucket's versioning state. `rollback` then:
1. re-uploads every captured root file except `index.html` and `config.json` (one `aws s3 cp` each; `cp` is used on purpose, because `aws s3 sync` skips a file whose size matches even if its content differs);
2. re-uploads the captured `index.html` with `Cache-Control: no-cache`;
3. creates one invalidation on the TEST distribution and waits for it;
4. downloads the live front page and refuses to report success unless it is byte-identical to the captured `index.html`.
New hashed assets stay in the bucket (harmless: nothing references them once `index.html` is restored). Old assets were never deleted, so the previous site works immediately. `config.json` is never read for writing.

## Operator command (CloudShell, from the same checkout used for `publish`)
```bash
OGEVIA_DEPLOY_APPROVAL=owner-go-test-web-0052-2026-10-16 bash infra/aws/slice/test-web-release.sh rollback
# type ROLLBACK TEST when asked
bash infra/aws/slice/test-web-release.sh verify     # after a rollback `verify` is expected to FAIL on "live index.html is byte-identical to the build"; that confirms the new site is gone
```
Expected last line: `ROLLBACK DONE (TEST). The live index.html is the captured one.` Time: about 2 to 4 minutes (invalidation wait).

## Manual fallback (if the script cannot be used)
```bash
RB=~/ogevia-test-web-release-d82fefc/rollback/web
BUCKET=<TEST site bucket, from stack Ogevia-prod-WebHosting output SiteBucketName>   # never a bucket from Ogevia-prd-*
for f in $(cd $RB && find . -maxdepth 1 -type f ! -name index.html ! -name config.json | sed 's#^\./##'); do aws s3 cp "$RB/$f" "s3://$BUCKET/$f"; done
aws s3 cp "$RB/index.html" "s3://$BUCKET/index.html" --content-type "text/html; charset=utf-8" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id <TEST distribution, output DistributionId> --paths "/*"
```
If the local rollback copy is lost and the bucket is versioned (recorded in `CAPTURE_OK`), restore `index.html` from the previous S3 version id recorded in `rollback/index-head.json`.

## What was verified, and what was not
- **Verified (automated, `infra/aws/test/test-web-release.test.ts`, against test doubles):** after publish then rollback, the simulated TEST bucket's `index.html` and `config.json` are byte-identical to the captured ones; the simulated PROD bucket is byte-identical to its start; a wrong typed phrase stops the rollback; every write targets the TEST bucket or the TEST distribution.
- **Not verified:** a rollback on the real TEST site (it has not been run; the first real use is under the authorization). The script's real `aws` calls use the standard commands above.
- **Not covered:** database or API rollback (not part of this release).
