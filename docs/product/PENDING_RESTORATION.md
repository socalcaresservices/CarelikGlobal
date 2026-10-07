# Pending restoration: features the AWS build does not have yet

7 October 2026. These features exist in the Supabase-era product (code, migrations or documents) and are **pending restoration on AWS. None is discarded.** "No AWS module exists" explains a gap; it does not decide whether the feature is needed. Whether and when each is restored is the owner's decision. Nothing here proposes a new rule: where a rule exists it is quoted from the existing definition, and where an owner decision is needed it is listed as a question, not answered.

**How this was built.** Read from the repository (migrations, tests, pages, documents, and the six stacked branches #53 to #58) without running any database. I checked these points myself: AWS has no CareScore function, no caregiver skills, no caregiver cities, no incidents tables or pages, and no caregiver-services list; its matcher is a yes/no filter. Everything else comes from that reading and is marked by source. The July archive repository (`socalcaresservices/carelik`) is not available here, so anything known only from it is "defined in documents only".

## 1. Inventory

| Feature | Existing definition | In AWS today | Status |
| --- | --- | --- | --- |
| **CareScore** (match score 0 to 100 with a breakdown) | In code, four versions (section 2) | None. `list_available_caregivers` filters yes or no, no score (0011) | **Pending restoration** |
| **Caregiver skills** | In code (#54), catalog `20260727070000` | None | **Pending restoration** |
| **Caregiver services supported** | In code (#58) | Only the agency service catalog and `caregiver_assignments.service_id` (0023) | **Pending restoration** |
| **Caregiver preferred cities** | In code (#58) | None (the only AWS city column is the client's, 0022) | **Pending restoration** |
| **Languages** (caregiver languages, client language needs) | In code | None | **Pending restoration** (PHI decision first) |
| **Matching: proximity, history** | In code (CareScore inputs) | None | **Pending restoration** (with CareScore) |
| **Overnight availability** | In code (#55) | **Built on the working branch (0037), not applied or deployed** | Built, awaiting approval to deploy |
| **Weekend availability, date exceptions** | Weekends in code; date exceptions exist in AWS only | Present (0011) | Present |
| **Incidents**, including several categories per incident | In code (`20260719270000`, catalog `20260820040000`, #57 `20260826050000`) | None | **Pending restoration** |
| **Credentials and expiry** | In code (Supabase) | Mostly replaced by Documents (0021, 0033). Gap: required types per role | Partly present; gap pending |
| **Authorizations page** (usage and expiry statuses) | In code | Admin only on the client page; no top-level page; the 4 usage states and 30-day expiry are not ported | **Pending restoration** |
| **Client operations: month hours by source** (requested, scheduled, confirmed, billable, remaining, projected) | In code (#56) | Partial (0020): no "requested" (no requested-schedule table), no separate "confirmed", no "projected" | **Pending restoration** |
| **AskCare** | **Documents only** (July archive: a rule-based question box, four intents) | None | **Pending restoration** (rebuild from the description) |
| **Support access** (time-boxed, tenant-approved platform access) | In code (`20260807000000`, `20260809021702`; follow-up #43) | None. The AWS design deliberately has no platform-owner bypass | **Pending an owner-approved design** |
| **Replacement-offer texts on call-out** | In code (`call_out_shift`) | None | **Pending a decision** (PHI in text messages) |
| Candidates and applicants, Settings and Access pages, public landing and pricing, platform admin, "mark as submitted" ledger, owner financial home items, reset branding | Documents and code | Not migrated | Pending, lower priority; listed in `FEATURE_RECOVERY_INVENTORY.md` |

## 2. Existing requirements to restore (quoted, not changed)

### CareScore: four versions, not blended

1. **Original** (`20260719280000_caregiver_client_matching.sql`, `list_caregiver_matches`, permission `shifts.update`). Total 0 to 100 as the sum of five parts: **proximity 30** (same ZIP 30; same city and state 18; same state only 6; otherwise 0; "never assume a match without at least a state in common"), **language 25** (25 if the client lists none, otherwise 25 x overlap / needs), **availability 20** (a capacity proxy from weekly target hours minus hours already scheduled; headroom of 10 hours or more gives 20), **skills 10** (10 if the client lists no care needs, otherwise 10 x overlap / needs), **history 15** (15 x min(completed together, 3) / 3, minus 10 for an unresolved incident for that caregiver and client, not below 0). Proximity and availability are text and capacity proxies, not distance.
2. **Production Supabase version** (`20260823080000`). Availability is split: capacity 0 to 12 and real availability 0 to 8 (the share of the client's requested windows that overlap a caregiver window on the same weekday; 8 when the client has none or the caregiver has none recorded). Everything else as above. This is the version the UI text describes ("proximity, language, availability, skills, and shared history", with "Proximity x/30 · Language x/25 · Availability x/20 · Skills x/10 · History x/15").
3. **#53 missing-data rule** (`20260826010000`). Weights unchanged. If the client recorded a need and the caregiver has no data, that part scores 0 and the gap is named ("Not recorded (scored 0)"); if the client recorded nothing, everyone gets the same neutral credit. Reason given in the file: the ranking drives replacement texts, so an incomplete profile must not outrank a verified fit.
4. **#58 additions** (`20260826060000`). "Score and weights unchanged." Adds explanations only: missing data may now include services; notes that never change the score ("Doesn't support the requested services", "Supports only some requested services", "Outside preferred cities").

Role access (existing): only holders of `shifts.update` see matches; caregivers never see scores. The July archive used different weights (availability 30, skills 30, language 20, capacity 20) and `FEATURE_RECOVERY_INVENTORY.md` says the later Supabase definition is the current one. The owner's own instructions (`OGEVIA_UX_CHANGE_LIST.md`): do not invent a formula; do not add maps or invented criteria; explain why a candidate qualifies or not; identify and build the AWS dependencies before calling it live.

### Skills, languages, services, cities
- Skills and languages are agency catalogs (`20260727070000`) stored by name; matching is exact text overlap, so a misspelling costs points. #54 puts skills on the caregiver record (union with a linked profile's).
- Services supported: `caregiver_record_services` (one row per record and service); edited with the membership-update permission (#58).
- Preferred cities: `caregiver_records.preferred_cities`, matched case-insensitively on trimmed text against the client's city (#58). Notes only; never part of the score.
- Client side: `client_requested_services`; `client_requested_schedule` (up to two windows a day).

### Incidents
`20260719270000`: category, severity (low, medium, high), status (open, under review, resolved), description, occurred-at, client, caregiver, shift, reporter, resolution notes. Permissions `incidents.read`, `incidents.create`, `incidents.update`; a caregiver always sees what they filed. Audit trigger. Catalog of incident types (`20260820040000`). #57: one incident can have several categories (at least one; the first stays the primary). An open incident for the same caregiver and client costs 10 History points in CareScore. The incident row has no caregiver-record link, so a caregiver without a login can never trigger that.

### Authorizations, credentials, client operations, support access, AskCare
As summarized in section 1 and the sources named there. AskCare (documents only): four rule-based intents (best staff for X, who is free on a day, who is unstaffed, how much is unstaffed in a city, to be labelled potential revenue not loss), answers inside the signed-in user's agency and permissions, with supporting records and date scope, missing information acknowledged, no authority to approve billing or change records, and no real client data to an unapproved AI provider. "A static chat box does not count as restored AskCare."

## 3. Ordered restoration plan

Each step names what it needs first. Steps 1 to 3 carry no scoring rule.

| # | Step | Needs first | Notes |
| --- | --- | --- | --- |
| 0 | **Owner decisions** (section 4) | None | Blocks steps 4 to 7. |
| 1 | **Overnight availability** | Approval to deploy | Built on this branch (0037) with tests; the scorer's window match needs it. |
| 2 | **Caregiver profile fields**: services supported, preferred cities, skills, languages, desired weekly hours, with agency catalogs | Decision 0 on who edits and who sees | Caregiver data, edited on the Care Team detail page. Services and cities carry the least privacy risk and give immediate value in the candidate list as plain facts, with no score. |
| 3 | **Client-side inputs**: requested services, requested schedule, and (only if decided) language needs, care needs, state and ZIP | Decision 0 on the privacy boundary | AWS today holds clients as codes with names and city gated. Needed for the language, skills, proximity and window parts. |
| 4 | **CareScore scorer** restoring the chosen existing definition, with its tests ported from `supabase/tests/care-score` | Steps 1 to 3 and the version choice | An internal function plus a permission-checked route (shifts or care-requests manage). The #53 and #58 behaviours are additive. |
| 5 | **Use it in AWS workflows**: score and plain-language explanation on care request candidates | Step 4 | Replacement texts on call-out stay off until the text-message decision. |
| 6 | **Incidents module**, with several categories and a caregiver-record link | Decision on categories, severity and who sees them | Also feeds the History part of CareScore. |
| 7 | **Authorizations page** and statuses; credential types per role; client operations by source | Step 3 for "requested" hours | Mostly assembling data AWS already has. |
| 8 | **AskCare** (rule-based) | Steps 2 to 5 | Server-side queries only, inside the agency and permissions. |
| 9 | **Support access** | An owner-approved design | Changes tenant isolation, so design and review come before code. |

## 4. Questions only the owner can answer (not answered here)

1. Is CareScore wanted in the controlled pilot, or a later build?
2. Which version is authoritative: the production Supabase version, plus #53 and #58 as additions?
3. May client address (ZIP, state), language needs and care needs be stored in AWS for scoring, given that clients are codes with gated names today?
4. Who edits caregiver languages, skills, cities and services, and who sees scores?
5. Free-text skills and languages, or an agency-defined catalog?
6. Should services and cities ever affect the score or eligibility? (Today they are notes.)
7. Should expired or missing credentials, or a do-not-send list, ever block matching? (Nothing does today.)
8. Is the 10-point history penalty for an open incident acceptable, given that incidents carry health and safety detail?
9. Incident categories, severities and visibility in AWS; may caregivers file and see their own?
10. AskCare: which questions, who may ask, "potential revenue" wording, and is any AI provider acceptable?
11. Support access: should it exist in AWS, with what approval, duration and audit?
12. Authorizations page: keep the 30-day expiry and 90 percent "approaching limit" thresholds?
13. Replacement-offer texts: allowed, to how many people, with what content (no client name)?
14. Required credential types per role: the list and who sets it.

## 5. Not found
AskCare source code (anywhere in this repository); any GeoScore implementation; any rule linking credentials to matching; date-exception handling in the Supabase scorer; the July archive repository; live Supabase or AWS state.
