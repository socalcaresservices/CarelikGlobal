# Unified caregiver-readiness release: owner brief (faithful condensed record)

Recorded 2026-10-09. Branch `feature/caregiver-readiness`, based on PR #75 head `111fc7cea90296fc430a9b9a0c1f5100fcbe6cbe`
(PR #75 = main `a59a4b8` + 2 commits). **Dependency: this branch contains PR #75's commits. PR #75 must be merged first, or this
branch rebased on main after it merges. PR #75 is not merged by this work.** Status words used below: proposed, implemented, tested,
deployed. Nothing in this release is deployed. No production deployment is authorised.

The brief below condenses the owner's instruction text section by section without changing requirements; the owner message is the authority.

---

TASK: Build Ogevia's unified caregiver-readiness release. This message is the complete brief. It supersedes conflicting historical
migration instructions and earlier feature defaults. Do not restart Phase 0 migration. Do not deploy or modify live AWS resources.

**A. Start from the correct code.** Preserve `claude/magical-thompson-e7x814` and its stale documents (do not reset or merge them).
Fetch main and PR #75; isolated feature branch/worktree from PR #75's head; record the dependency; do not merge PR #75 without owner
instruction; confirm branch, base commit and receipt of brief; short plan, then implement and test in reviewable commits in one release.

**B. CLAUDE.md standing rules.** Current task first (follow current explicit instructions; historical phases do not restart; verify
checkout freshness and branch; invalid container credentials mean access is unavailable, not that deployed resources are missing).
Reuse existing tools (inspect first; no duplicate platforms; a new tool needs a demonstrated gap, alternatives, cost, migration impact
and owner approval; do not reopen settled hosting/architecture). Accurate records (distinguish proposed/implemented/tested/deployed;
do not overwrite current records with stale-code findings; save this brief, decisions and notes in repo docs; report actual tests).

**C. Sidebar, Option B.** Check whether already implemented (PR #75 workflow grouping alone does not satisfy it). Preserve labels,
groups, order, icons, routes, permissions, width, collapse controls, mobile behaviour; page content and calendar unchanged.
Background #FAFBFC; right border 1px #E2E8EC. Group headings 12px/700/#334155, line-height 18px, letter-spacing 0.06em, wording and
casing preserved; 1px #DCE5E9 divider after heading with 10px gap; ~20px group spacing. Links 14px/500/#243244; desktop rows >= 40px,
shallow indent; icons 18px with 8px gap. Selected row #E8F5F4, text #0F6674, weight 600, radius 6px, no vertical accent bar. Hover
#F0F7F7; visible 2px #0F6674 focus outline. Long labels wrap. Coarse-pointer targets >= 44px. Collapsed mode hides headings/dividers
and keeps accessible icon labels and tooltips. Existing styling/components; no global CSS changes.

**D. Availability: administrator approval.** Caregivers request changes to their own availability: reason and effective start date
required; weekly hours, different hours per day, multiple windows, date-specific exceptions; temporary changes need an end/expiry.
Pending requests do not change approved availability. Only an authorised administrator approves or declines; declining needs a note.
Caregiver sees current approved hours and request status. Administrator direct edits require a reason and audit record. Record
requester, reviewer, timestamps, approved version. States: pending, approved, declined, withdrawn, superseded. Fix the
exception-deletion issue. Prevent stale saves, duplicate approvals, silent overwrites. A date override replaces its intended hours
rather than widening availability by union. Show agency timezone and "Not provided". Flag affected future shifts; preserve committed
shifts. Approval does not assign work or approve a visit.

**E. Caregiver service approvals.** Per agency, caregiver and service: status, effective dates, administrator, reason, revocation
history. Caregivers view their own, cannot approve themselves. Administrator-only initially; not every manager. Keep separate:
caregiver service approval, client service authorisation, client assignment, employment/delivery model. Never infer approval from
assignments or documents. Existing caregiver/service pairs may populate a review list; administrator-confirmed bulk approval may
select explicitly reviewed pairs, never every pair automatically. Approval must cover the whole work interval incl. overnight.
Revocation preserves evidence of historical authorisation; flag affected standing assignments and future shifts. Do not alter
historical visits or billing approvals.

**F. Required documents: CPR and TB.** Reuse existing document types/upload/verification/expiry. Before new assignments and new visit
starts require CPR on file, administrator-verified and current; TB on file, administrator-verified and current under the agency's
configured policy. Upload alone is not verified. Missing/rejected/unverified/expired blocks work. Validity covers the work interval.
Do not invent legal expiry periods. TB validity may differ from certificate expiry: explicit agency rules; unset rules = incomplete
setup. Document readiness is separate from service approval; neither bypassed by score or availability override. Flag future
commitments affected by expiry. Preserve history. Do not interrupt an in-progress visit.

**G. Assignment safety.** Distinguish availability, service approval, document readiness, client assignment, shift acceptance, visit
approval. Before committing work check: (1) agency and authorised actor; (2) caregiver status; (3) service approval covers full
interval; (4) CPR/TB verified and current; (5) client authorisation applies and hours suffice under existing accounting/reservation
rules; (6) approved availability covers the work; (7) no overlap; (8) recorded mandatory client requirements. Apply to care requests,
direct shifts, recurring shifts, rescheduling, standing client assignments, new visit starts. Standing assignment: creating the
relationship differs from permission for a dated visit. Candidate matching uses approved availability; "Not provided" is not
available. A separately authorised administrator may override availability for a specific assignment with a recorded reason; this
never bypasses service approval, documents, tenant permissions or other mandatory safeguards. Recheck at commit time. Resolve the
reported Care Request concurrency gap; use consistent locking/transactions across assignment, approval, revocation and
document-verification; identify unprotected paths. Do not retroactively change manager-approved unscheduled visits. Once enforcement
is active, new visit starts (incl. via standing assignments) require service and document readiness.

**H. Enforcement transition.** Controlled review of existing caregivers/commitments; do not silently strand work. Temporary service
check switch if needed: administrator-only, audited, label "Service checks", states "On"/"Off"; when off show "Service checks: Off"
and "Caregivers can be assigned without service approval." with action "Review services". It must not disable CPR/TB or other
safety checks. Show setup gaps and affected future work before activation. Never enable production enforcement automatically.
Report migration/cutover dependencies.

**I. Explainable matching.** Filter for eligibility first, then rank. A score never overrides a failed requirement. Do not call
already-assigned caregivers the only eligible candidates. Inspect AWS matching and legacy code; do not port misleading legacy
proximity/availability proxies. Evaluate provisional weights 50% availability / 25% location / 25% relevant experience; show worked
examples before treating the formula as settled; explain that for a fully covered single shift availability gives all eligible
candidates the same value and propose a meaningful ranking; recurring work shows covered/total occurrences; partial coverage is
separate and uncovered occurrences are never assigned as if available. Experience: relevant tags, caregiver-reported vs
administrator-reviewed, preference unless mandatory, tags do not imply certification, missing != reviewed-no-match. Location: city/ZIP
text is not distance; ZIP-centroid distance only with a dataset of verified source/licence/vintage, labelled "Approx. distance"; no
external geocoding without owner approval; a provisional radius is not an approved hard limit; protect addresses. Scoring: show
component reasons, deterministic ties, missing inputs not silently zero/perfect, "Score incomplete" when no comparable total,
eligibility separate from score, record scoring-rule version, mandatory client requirements are gates.

**J. UX.** Labels: Availability / Approved services / Documents / Matches; Pending / Approved / Declined / Not provided; Needs review
/ Missing / Expired / Unverified / Revoked; Approve / Decline / Request change. Caregiver profile sections: Availability, Approved
services, Required-document status, approved state distinct from pending. Availability request: Weekly hours / Specific date; Days
and times; Starts / Ends; Reason; Submit request. Confirmation: "Request sent. Your current hours stay in place until approved."
Admin review: current vs proposed, reason, affected shifts; Approve / Decline; details text "Approving availability does not assign
work or change booked shifts." Assignment: client and service clear; availability, service, documents, conflicts shown separately;
messages "Outside approved hours." "Availability not provided." "Not approved for this service." "CPR expired." "TB needs review."
"Already booked." Errors match the actual failure. No "Ready to assign" unless required checks pass; blocked caregivers not shown as
assignable. Loading, empty, error, success states; preserve form values after errors; prevent duplicate submissions; existing
components and Option B palette.

**K. Validation and delivery.** Synthetic data. Tests: own-user/admin/cross-tenant; pending preserves approved; exception
preservation and temporary changes; stale edits, repeated approvals, concurrency; whole-interval validity, overnight, DST;
missing/expired/unverified CPR and TB; service mismatch/expiry/revocation; authorisation limits and overlap; historical visit and
approval preservation; matching arithmetic, missing inputs, explanations; desktop/mobile/collapsed nav and keyboard. Deliver: changed
files and commits; tests actually run, failures, untested behaviour; screenshots of the real workflow; migration -> API/routes -> web
order; data-preserving rollback plan; remaining policy decisions and risks; updated docs and release notes; review of marketing
match-score claims. Rollback must not default to dropping populated tables. Implemented does not mean deployed. No production
deployment is authorised.
