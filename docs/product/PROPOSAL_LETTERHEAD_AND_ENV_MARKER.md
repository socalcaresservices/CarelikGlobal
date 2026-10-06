# Two separate fixes: printed letterhead contact data, and the TEST environment marker

6 October 2026. Design proposals only: nothing here is built, and nothing in AWS was touched. Each is independent and can be approved, changed or declined on its own. I checked the file paths, the next migration number (0037 is free; 0001 to 0036 exist), the route registration points and the config key list myself. Everything else is from reading the code and was not run.

If the overnight availability fix in `OMITTED_BRANCHES_COMPARISON.md` goes first it takes 0037 and the letterhead migration becomes 0038. Numbers below are provisional for that reason.

---

## Fix A. Agency contact details on printed reports

**Problem (verified).** `apps/web/src/lib/sv-backend-aws.ts` `getLetterhead()` returns the street, city, state, ZIP, phone and email as `null` because the AWS database has nowhere to store them. Printed reports therefore show the agency logo and name only. The print header already prints these lines when they are present, so no print layout change is expected (the template reads the same fields the Supabase build fills).

**Proposal.**

| Part | Change |
| --- | --- |
| Database | New migration `infra/aws/db/migrations/0037_org_letterhead_contact.sql`. Add nullable columns to `ogevia.organizations`: `address_street`, `address_city`, `address_state`, `address_zip`, `contact_phone`, `contact_email`. Checks: lengths (street 120, city 80, email 254), state is two capital letters, ZIP is 5 digits or ZIP+4, phone is 7 to 20 characters of digits and `+()-. `, email has one `@` and a dot, no control characters. |
| Read | Replace `ogevia_api.get_organization_branding(uuid)` (0020) with a version that also returns the six fields. A returning-table function cannot be changed in place, so drop and recreate it and re-grant execute. Anyone active in the agency can read it, as today. |
| Write | New function `ogevia_api.set_organization_letterhead(...)`. It requires `organization.update` (the Administrator), is idempotent with a key, and writes an audit row (`organization.letterhead_updated`) with before and after, copying `set_organization_branding` (0020). The existing branding function is left untouched. |
| API | `GET /v1/branding` returns the new fields with no new route. Add `POST /v1/branding/letterhead` in `apps/sv-api/src/routes.ts`. A new route must also be added to `infra/aws/lib/service-verification-api-stack.ts`, the increment gate (`infra/aws/slice/increment_diff_gate.py`) and the contract tests. The alternative is to extend the body of `POST /v1/branding`, which avoids a new route but changes an existing function's signature. I recommend the separate route for a cleaner audit trail. |
| Web | Add the six fields to `Branding` (`aws-workspace.ts`), a "Print letterhead" section on the Branding page (`workspace-settings-pages.tsx`, Administrator only) with the note "Agency business contact only. Never enter client or caregiver details.", and map them in `getLetterhead()`. |
| Tests | Database: Administrator can set and it is audited; manager, caregiver and other-agency members are refused; invalid values are rejected; blank clears; a retried request replays. Handler and web tests as for branding. Update the schema version checks (`verification/01_schema_version.sql`, `schema.db.test.ts`) and the infra route-count assertions. |
| Rollback | `rollback/0037_org_letterhead_contact.down.sql` restores the four-column function and drops the columns, and refuses to run if any contact value exists (export first), as the 0036 rollback does. |
| Cost, privacy | No new AWS resource: cost impact none. This is agency business contact data, not client or caregiver data. It is checked on the server and audited. |
| Deploy order (owner-run) | Snapshot the database; apply 0037 (additive, safe with the currently deployed API); deploy the API; upload the web build; smoke test by saving and printing. Rollback in reverse. |

**Decision needed:** approve the separate route (my recommendation), or the no-new-route variant.

---

## Fix B. TEST environment marker

**Problem (verified).**
- The only marker is a fixed sentence on the Clients page (`apps/web/src/aws/clients-page.tsx:130`): "TEST environment: synthetic clients only until the security approval." It would also appear in a production build and appears nowhere else.
- The sidebar shows an environment chip only if the build was made with `VITE_APP_ENV` set to `test` or `development`. The deployed `/config.json` cannot carry it (`RUNTIME_KEYS` in `aws-runtime.ts` lists only Cognito and API values), so a deployed build shows it only if it was set when the web bundle was built.
- `/config.json` is written by deploy scripts (`infra/aws/slice/finish.sh:121`, `pilot-deploy.sh`, `infra/aws/scripts/deploy-test-slice.sh`), not by CDK. The 0026 and 0036 release scripts deliberately do not touch it, so a normal release will not add the key.

**Proposal.**

1. **One key, reuse the existing name.** Add `VITE_APP_ENV` to `RUNTIME_KEYS` so a deployed `config.json` can set it. The build-time value stays as a fallback.
2. **Write it where config.json is written.** The deploy scripts add `"VITE_APP_ENV"` from a variable `OGEVIA_APP_ENV` (default `test` in the TEST scripts). No CDK change; this infrastructure does not currently carry such a value, so I am not inventing one.
3. **Show it everywhere it matters.**
   - A full-width amber banner under the top bar on every page and in the mobile drawer: "TEST environment: synthetic data only".
   - The sidebar chip stays.
   - On printed reports, a line "TEST ENVIRONMENT, NOT A RECORD" in the running print header, so a test printout cannot be mistaken for a real one.
   - Delete the fixed sentence on the Clients page.
4. **What happens when the key is missing.** Today: no marker. That is risky if someone drops `config.json` on the TEST stack. Two options:
   - (a) Keep: missing means no marker.
   - (b) Safer: anything other than an explicit `production` shows the marker, and the live deploy script must write `production`. My recommendation is (b) once the production script writes the value explicitly. It changes the default for the build-time `development` value, so it needs your decision.
5. **Tests.** The runtime config merge accepts the key and still drops unknown ones; the shell banner shows for `test` and not for `production`, follows your choice for missing or unknown values, and appears on a non-Home page; the Clients page no longer contains the old sentence; the print header carries the label; optionally a smoke check that `config.json` has the key.
6. **Deployment split.**
   - Code (reviewed change): the web changes, tests and the script edits.
   - Owner-run: build and upload the web bundle, then rewrite `config.json` on the bucket with the new key (`--cache-control no-store`) and invalidate CloudFront, because release scripts skip that file. Keep a copy of the old file for rollback.
7. **Cost and security.** No cost. The label is not secret; `config.json` stays identifiers only.

**Decision needed:** (a) or (b) for a missing key; and confirm the banner wording.

---

## Not determined
- How `AwsApp` hands the runtime to the shell is known from `main.tsx` (the merged env goes into `createAwsRuntime`); the exact plumbing of the label into `AwsShell` is not written yet.
- Whether a production `config.json` deploy path exists outside the TEST scripts.
- Live AWS state (no AWS access in this session).
