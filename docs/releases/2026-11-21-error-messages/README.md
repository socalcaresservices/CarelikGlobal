# "Could not reach Ogevia" on Retire document type (2026-11-21)

## What was reported
Documents > Document types and reminder days: retiring `cpp` with the reason `duplicate` showed "Could not reach Ogevia. Check your connection and try again."

## Root cause (reproduced; VERIFIED in the local harness, real browser, synthetic data)
1. Retire document type, Cancel document request and Mark read / Mark all read call three routes that exist only when the `requestCleanup` release switch is ON (`infra/aws/lib/service-verification-api-stack.ts`, `feature: "requestCleanup"`).
2. Where the switch is off the route does not exist. API Gateway answers 404 **without cross-origin headers**, so the browser reports a failed request (TypeError "Failed to fetch"), not a 404.
3. The one shared client (`apps/web/src/lib/aws-api.ts`) turns every failed request into the status-0 "Could not reach Ogevia" message. The pages' own "not available in this environment yet" handling only triggers on a real 404, which a browser never sees here (their tests used a fake API that threw a 404, which is why this was not caught).
4. The screens do not hide the controls where the routes are off. The Offices controls do (they show only when their list loaded).

## Which environment
UNKNOWN from the screenshot (no address bar). Both environments lack the routes, so either would produce it:
- TEST (`Ogevia-prod-*`, ogevia_sv_test): migration 0109 applied (ledger 108/0109 at the H3 probe, 109/0110 after); API 259 routes before the Offices release, 265 after (six office routes); request cleanup OFF (the H3 run printed "request cleanup is OFF"); web and Handler at 9f21c499. The H2c switch-on for TEST was prepared but never run, and its saved state is stale after H3.
- Production (`Ogevia-prd-*`): release 2b07ae4 (PR #113) deployed with the switch OFF; 0109 applied; the switch-on block was prepared and, as far as this record knows, not run. Offices not deployed.
- Request capture: not possible from here (no access to either site or to AWS). The failing request is `POST /v1/document-types/<id>/retire`; in DevTools > Network it shows as failed/(blocked) with no status; the response's request id is not readable cross-origin.

## Where the generic message can appear
Only `createAwsApiClient` in `apps/web/src/lib/aws-api.ts` produces it, so every call in the app could show it. The call sites that hit a switch-gated route: retire document type, cancel document request, mark read / mark all read (requestCleanup); Offices (offices, already hidden when unavailable); duplicates and merge (staffDuplicates, off in TEST and production); bulk import (bulkImport, off in production); sign-in override (off in production unless added separately); live-TEST repair routes (liveTestRepairs, TEST only).

## Fix (code change) and what it does not fix
- `aws-api.ts`: for a fixed list of switch-gated paths (`SWITCHED_PATHS`, checked against the CDK route table by a test so a new switched route cannot be missed), a failed request triggers one check of `GET /v1/me`. If the API answers (any status), the error becomes 404 `not_available`: "This is not available in this environment yet." If the API does not answer, the message stays "Could not reach Ogevia".
- Also in the shared client, API Gateway's own answers (no Ogevia message body) now read correctly: 401 "Your session has ended. Please sign in again.", 403 "You do not have permission to do this.", 429 "Too many requests...", 5xx "Ogevia had a problem completing that...". A message the server sends always wins (business rules such as open requests).
- It does NOT make retire/cancel/mark-read work. That needs the `requestCleanup` switch ON in the environment (a deployment configuration change): TEST (H2c-style change set) and production (the prepared switch-on block). Until then the controls stay visible and say clearly that the action is not available yet. Hiding them would need a capability signal from the API, not built.

## Verification
Local harness, real browser (`infra/aws/local-harness/error-messages-checks.mjs`; results and screenshots in this folder). Retire document type under each condition:
| Condition | Before the fix | After the fix |
|---|---|---|
| Route works | retired | retired |
| Switch off (route missing) | "Could not reach Ogevia..." | "This is not available in this environment yet." |
| Expired sign-in (401, gateway body) | "The request failed. Please try again." | "Your session has ended. Please sign in again." |
| No permission (403, gateway body) | "The request failed..." | "You do not have permission to do this." |
| Business rule (409, server message) | server message | server message (unchanged) |
| Server failure (500) | "The request failed..." | "Ogevia had a problem completing that..." |
| No connection at all | "Could not reach Ogevia..." | "Could not reach Ogevia..." (unchanged, correct) |
Unit tests: `apps/web/src/lib/aws-api-switched.test.ts` (15 tests, including the drift guard against the CDK route table). Full web suite 1396 passed; lint and typecheck clean.

## Not done / pending
- NOT verified in TEST or production: this session cannot reach either. TEST needs a web publish of the fix (web only; no API or database change); production needs its own approval.
- Production: unchanged.

## TEST deployment record (2026-11-21)
- Web-only publish of release commit `a6f7e3ccb990547820af8f3be4f47caad0f4bb9c` to the TEST site with `TEST_WEB_FIX.sh` (CI green: harness, validate, postgres). Operator output: "TEST WEB PUBLISHED ... serves a6f7e3cc". API, database and switches untouched; production untouched.
- Rollback reference (CloudShell, ephemeral): `/tmp/ogevia-wf-11211250/webfix-20261121T125102Z`.
- NOT yet verified: the owner's Retire check on TEST (expected: "This is not available in this environment yet."). The TEST `requestCleanup` switch is still OFF, so the action itself does not succeed there. Production: unchanged, pending approval.
- TEST check (owner screenshot, 2026-11-21): Retire document type on TEST now shows "This is not available in this environment yet." (no longer "Could not reach Ogevia"). The action does not succeed on TEST because its `requestCleanup` switch is OFF.

## Retire acceptance (owner's check: successful retirement)
Local harness, synthetic data, all routes present (`infra/aws/local-harness/retire-acceptance.mjs`; results and screenshots in `retire-acceptance/`): 16 checks passed. A duplicate type with an open request is refused with the business-rule message; after the request is cancelled, retiring with a reason shows "is retired and can no longer be requested", the type disappears from the active list at once and after a reload, is listed under "Retired (cannot be requested)", and is not offered on a new request. The type row is kept (inactive, with who and when), the cancelled request is kept and still points at it, the cancel reason is recorded, and the audit event `document_type.retired` carries the reason and the before/after state.
TEST: NOT yet run. TEST's `requestCleanup` switch is OFF (265 routes). `TEST_H6_CLEANUP.sh` (TEST only, API only) adds the three routes (265 to 268); prepared and tested with stand-ins and a real synthesis; not run. Production: read-only status check pending; no change.

## TEST request-cleanup switch ON (2026-11-21, owner GO for TEST)
- `TEST_H6_CLEANUP.sh` at release commit `9b0e55512a4910a06f4f3437d22ad6a40aa0e819` (CI green). Operator output: "H6 COMPLETE (TEST): request cleanup is ON (268 routes). Retire document type, Cancel document request and Mark read now exist and require a sign-in. Offices unchanged. Production was not touched."
- API only (265 to 268 routes); no database or web change. Rollback reference (CloudShell, ephemeral): `/tmp/ogevia-h6-11211315/h6-20261121T131613Z`.
- NOT yet verified: the owner's retire acceptance on TEST (synthetic duplicate: gone from the active list at once and after reload, not offered on new requests, history and audit kept). Production: unchanged.
- TEST retire acceptance (owner report, 2026-11-21): PASS. `cpp` retired on TEST: "cpp is retired and can no longer be requested. Existing records are kept." Reported as a single pass; the individual steps (active list immediately and after reload, not offered on new requests, history and audit) were not itemised and no screenshot was attached. Owner wrote "this a go" (scope of the production GO to be confirmed). Production: still unchanged.
