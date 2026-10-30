# 2026-10-28 staff invitation fix (0087: M-1, L-1, L-2, L-3)

Start with `RELEASE_MANIFEST.md`. Nothing here is deployed; no GO is requested.

- `RELEASE_MANIFEST.md`: production now vs candidate, plain-English changes, evidence
- `CHECKLIST.md`: release checklist for `fb491a5`; every approval UNSIGNED, earlier approvals kept as history
- `TEST_APPROVAL_REQUEST.md`: the unsigned TEST-only request, with checks split into before and after deployment
- `OWNER_DECISIONS_FOR_TEST.md`: recorded Owner decisions (P1, U6) and the open inputs: operator, window, approval reference, manifest review, V7
- `DEPLOYED_RECORD_TEST_fb491a5.md`: what is deployed on demo.ogevia.com (TEST), the timeline and the deviations (deployed, NOT accepted)
- `MIGRATION_STATUS_MATRIX.md`: 0086/0087 state and sequences for TEST and production
- `NOTHING_DROPPED.md`: lineage and nothing-dropped report, test counts
- `SECURITY_REVIEW_0087.md`: review of 0087
- `V4_READINESS.md`, `V5_V7_PREPARATION.md`: verification steps (prepared, not run)
- `OPEN_RISKS_AND_ASSUMPTIONS.md`
- `scripts/invitation_checks_v4.py`: read-only checker
