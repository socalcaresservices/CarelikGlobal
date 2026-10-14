# Open pull requests: relevance review (nothing was closed or changed)

Date 2026-10-14. 17 pull requests were open (#43 to #73, created 2026-08-24 to 2026-10-08) against `main` `484135d`. None concerns Wave 1 or migrations 0047 to 0052. **Method and limits:** each branch was compared with `main` for ancestry and commit counts (none is merged: all are 86 to 148 commits behind) and each feature was looked for on `main` by migration, route, test or history. This shows whether the *capability* exists on `main`; it is **not** a change-by-change comparison, and the "likely" rows were not verified that far. **No pull request was closed, commented on or modified.** Closing any of them is the owner's decision.

| PR | Title | Created | Class | Confidence | Evidence |
|---|---|---|---|---|---|
| #73 | docs(aws): prepare Phase 7 fixes and the read-only check for the produ | 2026-10-08 | ACTIVE (production decision) | high | Phase 7 fixes and the read-only check for the production deploy (7 commits, 6 files). Belongs to the production decision (C). |
| #72 | docs(aws): go-live runbook for switching app.ogevia.com to the AWS pro | 2026-10-08 | ACTIVE (production decision) | high | Go-live runbook for switching `app.ogevia.com` to the AWS production build. Belongs to the production decision (C); not for the pilot. |
| #71 | docs: correct the operating record and add an environments page | 2026-10-08 | ACTIVE | high | Corrects `OGEVIA_OPERATING_RECORD.md` and adds an environments page. Directly relevant to Blocker B-17 (what `app.ogevia.com` and `www.ogevia.com` serve). Needs the owner's statement, then merge or close. |
| #67 | AWS monthly summary: remaining hours subtract scheduled (reserved) tim | 2026-10-03 | LIKELY SUPERSEDED | medium | `remaining-hours.db.test.ts` on main covers remaining hours net of scheduled time; branch is a 143-commit stack. Not compared change by change. |
| #66 | AWS: let a visit manager close a missed clock-out with the actual Time | 2026-10-03 | SUPERSEDED | high | Re-landed as #65 'Let managers close a missed clock-out'; `close-missed-visit.db.test.ts` on main. |
| #64 | AWS Report Center: list missed clock-outs and unconfirmed visits under | 2026-10-03 | SUPERSEDED | high | Re-landed as #63 'Report missed clock-outs and unconfirmed visits'; present in `routes.ts` and the workflow tests. |
| #62 | AWS: let a caregiver clock in for a client they are scheduled to serve | 2026-10-03 | SUPERSEDED | high | Re-landed as #61 'clock in from a scheduled Care Request shift'; migration 0014 on main. |
| #60 | AWS: link visits to their scheduled shift and release the reservation  | 2026-10-03 | SUPERSEDED | high | Re-landed on main as #59 'Link Service Verification visits to scheduled shifts' and migration 0013. The branch is a stacked 139-commit original. |
| #58 | Record caregiver services and preferred cities; note them in CareScore | 2026-10-02 | NEEDS DECISION | low | Caregiver services and preferred cities: partly overlaps caregiver service approvals (0040) and ZIP structure (0043). Needs a person to say what is still wanted. 7 commits, 25 files. |
| #57 | Incidents can have more than one category | 2026-10-02 | NEEDS DECISION | low | Incidents with more than one category: incident handling is a different area (`action-center`); whether main already supports multiple categories is not verified. 3 commits, 7 files. |
| #56 | Client operations: month hours by source (requested, scheduled, worked | 2026-10-02 | LIKELY SUPERSEDED | medium | Hours by source (worked, billable, in review, scheduled ahead) appear on the Home dashboard and in the utilisation report on main. |
| #55 | Overnight availability and requested shifts (e.g. 22:00–06:00) | 2026-10-02 | SUPERSEDED | high | Overnight availability is migration 0037 on main (`overnight-availability.db.test.ts`). |
| #54 | Caregiver skills on the workforce record, so caregivers without a logi | 2026-10-02 | LIKELY SUPERSEDED | medium | Caregiver skills and experience are covered by experience tags and matching (0043). Not compared. |
| #53 | CareScore: missing caregiver data earns no match credit, and is named | 2026-10-02 | LIKELY SUPERSEDED | medium | Matching was rebuilt as eligibility-first explainable matching (0043) on main. Whether the 'missing data earns no credit' rule is preserved is not verified. |
| #52 | Care requests: self-service links, availability, assignment and covera | 2026-10-02 | SUPERSEDED | high | Care requests, links, availability, assignment and coverage are on main (migration 0011 and later, `care-requests.db.test.ts`). Draft, 138 stacked commits. |
| #51 | Reporting acceptance improvements: service-separated calendars and aud | 2026-10-02 | LIKELY SUPERSEDED | medium | Service-separated calendars and audit reports exist on main (client monthly calendar, correction-history report). Draft, 81 commits. Not compared. |
| #43 | Implement subscriber-controlled support access workflow | 2026-08-24 | NEEDS DECISION | low | Subscriber-controlled support-access workflow (Supabase era, 2026-08-24). Parts of the idea appear in `platform-shell` on main; the branch holds 9 more commits including a fix to its own migrations. A product decision, not a code review. |

## Summary
| Class | Count | PRs | Proposed handling (owner decides) |
|---|---|---|---|
| SUPERSEDED | 6 | #52, #55, #60, #62, #64, #66 | Close with a one-line pointer to what replaced each (high confidence) |
| LIKELY SUPERSEDED | 5 | #51, #53, #54, #56, #67 | I can compare each against `main` and report; then close (medium confidence) |
| NEEDS DECISION | 3 | #43, #57, #58 | A person says whether the idea is still wanted |
| ACTIVE | 3 | #71, #72, #73 | #71 after the owner's `app.ogevia.com` statement (B-17); #72 and #73 are production-decision (C) material |

None of these blocks the pilot. They are repository hygiene and the production decision.
