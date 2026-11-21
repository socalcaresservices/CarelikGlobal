# Verifying the release candidate `24fd8b1` on TEST (steps for the Owner/Operator)

Written 2026-10-27 on the Owner's instruction ("verify the resulting candidate on TEST"). **Nothing here has been run.** Every result below is NOT RUN until the Owner pastes the output. No check is passed or excepted by this document.

## What changes on TEST, and what does not
- **Changes:** the TEST website files only (the web build of `24fd8b1` with `VITE_APP_ENV=test`). Users of the Demo site see the amber band on the sign-in screen and a larger band in the app after a refresh.
- **Does not change:** the TEST API, the TEST database and ledger (85 / 0085 plus 0086), Cognito users and clients, DNS, anything production. The older web files stay in the bucket (nothing is deleted).
- **The API did not change** between the code TEST already runs (`7870a04`) and the candidate: the Handler asset `94b73574…` and Identity asset `7c5f8eb6…` are the same; verified again by step T4.
- **Test data created below** (a Scheduler staff member, a Caregiver sign-in) are synthetic TEST records in the TEST pool. They are not deleted by hand; correct them through the product (Deactivate / Disable).
- **No invitation to real staff:** use inboxes you control, for example plus-addresses of `admin.ogevia@gmail.com` (Gmail delivers `+tag` to the same inbox).

## Files to upload to CloudShell (Actions, Upload file)
1. The candidate tarball `ogevia-prd-operator-24fd8b1.tar.gz` (the same file the production GO names; its sha256 is in the covering message).
2. `web-verify-candidate.sh` and `staff_negative_checks_v3.py` from `docs/releases/2026-10-26-redesign/scripts/` (their sha256 are in the covering message).

## T0 - verify and extract the package (no change to AWS)
```
TARBALL_SHA=<64 hex from the covering message>
mkdir -p ~/ogevia-cand && chmod 700 ~/ogevia-cand
cd ~ && echo "$TARBALL_SHA  ogevia-prd-operator-24fd8b1.tar.gz" | sha256sum -c - && rm -rf /tmp/ogevia-cand-pkg /tmp/ogevia-cand-x && mkdir -p /tmp/ogevia-cand-x && tar -xzf ~/ogevia-prd-operator-24fd8b1.tar.gz -C /tmp/ogevia-cand-x && mv /tmp/ogevia-cand-x/ogevia-prd-0086-24fd8b1 /tmp/ogevia-cand-pkg && rmdir /tmp/ogevia-cand-x && (cd /tmp/ogevia-cand-pkg && sha256sum -c --quiet PACKAGE_MANIFEST.sha256 && echo "manifest ok" && jq -r .code_commit BUILD_INFO.json) && cp ~/web-verify-candidate.sh ~/staff_negative_checks_v3.py /tmp/ogevia-cand-pkg/ && sha256sum /tmp/ogevia-cand-pkg/web-verify-candidate.sh /tmp/ogevia-cand-pkg/staff_negative_checks_v3.py
```
Expected: `...tar.gz: OK`, `manifest ok`, `24fd8b17795dd7e0ba6f36eec1791918feefb216`, and the two script hashes from the covering message. Stop: anything else.

## T1 - install dependencies (no change to AWS)
```
cd /tmp/ogevia-cand-pkg && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store 2>&1 | tail -5
```
Expected: `Done in ...`. (If `pnpm` is not 9.15.4, use the Step 0 hint of the production procedure.)

## T2 - capture the TEST site before publishing (read-only)
```
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
out(){ aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
test "$(aws sts get-caller-identity --query Account --output text)" = 300094796789 && echo account-ok
BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName); WEB=$(out Ogevia-prod-WebHosting WebOrigin); API=$(out Ogevia-prod-ServiceVerificationApi ApiUrl)
echo "$WEB  $API"; case "$BUCKET" in ogevia-prd-*) echo "STOP: this is a PRODUCTION bucket";; *) echo "bucket looks like TEST";; esac
mkdir -p ~/ogevia-cand/web-before && aws s3 sync "s3://$BUCKET" ~/ogevia-cand/web-before --only-show-errors && (cd ~/ogevia-cand/web-before && find . -type f | wc -l && sha256sum index.html)
```
Expected: `account-ok`; `WEB` = `https://d2xumch5w0izfg.cloudfront.net`; `API` contains `s0epy5rgzb`; `bucket looks like TEST`. **Stop on `STOP: this is a PRODUCTION bucket` or any other API host.** Paste back: the output (bucket name not needed).

## T3 - publish the candidate web build to TEST only [YELLOW: changes the TEST site files]
Only after the Owner says go for this step. The reference below is a placeholder the Owner replaces with the approval reference she chooses (6-64 characters); this document does not choose it.
```
cd /tmp/ogevia-cand-pkg && export OGEVIA_APP_ENV=test VITE_APP_ENV=test VITE_APP_VERSION=24fd8b17795dd7e0ba6f36eec1791918feefb216 OGEVIA_DEPLOY_APPROVAL=<your approval reference> && bash infra/aws/scripts/deploy-test-slice.sh web 2>&1 | tail -15
```
Expected: the vite build output, S3 upload lines, `Open: https://d2xumch5w0izfg.cloudfront.net`. It uploads assets then `index.html`, never deletes, never touches `config.json`, and invalidates `/index.html` and `/`. Recovery: re-upload the files saved in `~/ogevia-cand/web-before` (`aws s3 cp`, assets first, `index.html` last with `--cache-control no-cache`), then invalidate.

## T4 - verify what TEST now serves (read-only)
```
sleep 60; cd /tmp/ogevia-cand-pkg && OGEVIA_EXPECT_COMMIT=24fd8b17795dd7e0ba6f36eec1791918feefb216 bash web-verify-candidate.sh /tmp/ogevia-cand-pkg
```
Expected: all `PASS`, ending `CANDIDATE WEB VERIFIED ON TEST`. It checks the served `index.html` equals the build; the bundle's version is the candidate commit; `VITE_APP_ENV:"test"`; both band texts are present; `config.json` names the TEST pool and API and no production identifier and is unchanged from T2; the TEST API still holds the pinned Handler asset. If only the first check fails, wait a minute and re-run once. Paste back: the whole output.

## T5 - browser checks of the band (the Owner's eyes; phone width too)
Open `https://demo.ogevia.com` **in a private window** (so no old page is cached), not signed in:
1. The sign-in screen shows an amber band reading **TEST — synthetic data only**, above the Sign in card. PASS/FAIL.
2. Sign in as the TEST Owner (`admin.ogevia@gmail.com`). The same amber band is at the top of every page, on its own line, and the sidebar footer separately shows **OWNER VIEW**. The two are different elements. PASS/FAIL.
3. Repeat 1 and 2 on a phone (portrait): no horizontal scroll, the band's text is readable and wraps, the Sign in button is visible. PASS/FAIL.
Send me what you see in words (no screenshots with real names or e-mail addresses).

## V5 - staff invitation by e-mail (TEST, the Owner's inbox)
As the TEST Owner on `https://demo.ogevia.com`:
1. Staff → **Add staff**. Name "V5 Scheduler Test", type Scheduler (or any active type), contact email = your own address, Save. Expect the person listed with **No sign-in**.
2. On that row choose **Invite**: sign-in email `admin.ogevia+v5sched@gmail.com`, role **Scheduler**, send. Expect status **Invited** and no duplicate person.
3. Open the invitation e-mail in the Gmail inbox, note the time, follow it, set a password. **Never paste the temporary password here.**
4. Sign in as that account. Expect it to work, and the amber band to show.
5. As the Owner, open Staff, check the person is **Active**; then **Disable access** and **Enable** again (Accounts). Leave the person in place.
Record each step PASS/FAIL/NOT RUN. A missing e-mail or failed sign-in is a V5 FAIL or BLOCKED, never an exception.

## V4 - the remaining caregiver checks
1. Care Team → open a synthetic TEST caregiver with no sign-in → Sign-in section → "Caregiver's email" `admin.ogevia+v4cg@gmail.com` → invite → complete the e-mail link and set a password.
2. Get the new sub (the newest user): `aws cognito-idp list-users --user-pool-id us-west-2_849AYz5J7 --region us-west-2 --query 'Users[].[Attributes[?Name==`sub`]|[0].Value,UserStatus,Enabled]' --output text`
3. Probe it (read-only): `cd /tmp/ogevia-cand-pkg && python3 staff_negative_checks_v3.py --client-id 1i27abbina08fvg1i9u8vprgo9 --probe <new sub>` Expect `status 200: [('scs-pilot-synthetic', 'caregiver')]`.
4. Run the full check with the Caregiver named: `python3 staff_negative_checks_v3.py --client-id 1i27abbina08fvg1i9u8vprgo9 --owner-sub 685183b0-f041-70fb-270e-d8ca934231d2 --nonowner-sub d86123c0-90b1-70a2-c52b-501f5efcf7ac --caregiver-sub <new sub> --other-agency-subs 58d173c0-e0d1-709f-4288-116f2ed5dbfc 8861c310-9081-70d4-85f7-0a33f9a58a94`
Expected: the Caregiver gets 403 on the four staff routes and the line `Caregiver not named: not checked` is gone; `STAFF CHECKS PASSED`.
Limits: direct Lambda calls with the account's sub, not a browser sign-in; read-only GETs of the four staff routes only.

## V6 - the three validators
`docs/releases/2026-10-26-redesign/RELEASE_COMPLETION_TEST.md` defines V6 as validators **other than the Owner**: Scheduler, Caregiver on a phone, Authorization. If you perform them yourself with the test accounts above, record that fact; whether that satisfies V6 is the Owner's decision, not this document's. The scripts are `DEPLOY_PLAN_TEST.md` section 9:
- **Scheduler** (the V5 account): the menu shows Schedule and Reports but not Billing, Staff Types or Roles & Permissions; the Staff and Roles pages refuse; schedule a shift, repeat it, change it; open the Requests tab.
- **Caregiver (phone)** (the V4 account): the menu shows My Schedule and Verify Visit; Availability and My documents are tabs; the drawer closes after choosing a page; start, end and confirm a visit on a synthetic client; Appearance is in the footer; no Administrator data is visible.
- **Authorization**: pick three TEST authorizations (one low use, one near its limit, one amended); recalculate each remaining balance by hand and compare to what the product shows, to the minute. The release does not change these numbers; this confirms it.
Each is recorded accepted, rejected or NOT RUN by the person who did it.

## Results record
| Check | Result | By / when |
|---|---|---|
| T0-T2 | NOT RUN | |
| T3 publish | NOT RUN | |
| T4 verify | NOT RUN | |
| T5 browser band (desktop, phone) | NOT RUN | |
| V4 caregiver checks | NOT RUN | |
| V5 invitation | NOT RUN | |
| V6 Scheduler / Caregiver / Authorization | NOT RUN | |
