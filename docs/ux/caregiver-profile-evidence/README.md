# Caregiver profile redesign: local evidence (SYNTHETIC data, local harness, NOT deployed, NOT TEST)

App code commit: `3bdfd9e7` (profile code `6a1f813e` plus the phone 44 px fix). Produced by `infra/aws/local-harness/run-caregiver-profile-pass.sh`: 32 of 32 checks passed (desktop 1360 px and phone 390 px).

- `desktop-*` and `phone-*` `1-overview`, `2-readiness`, `3-assignments`, `4-documents`: the real bundle on the harness database.
- `*-1b-overview-editing`: the contact email editor opened with Edit.
- `*-5-readiness-setup-gap-stubbed` and `*-5-readiness-real-hold-stubbed`: the readiness read is answered with a SYNTHETIC approved caregiver (stubbed response) to show the two setup-dependent states: CPR/TB document types not set up (stays Approved, no scheduling hold) and a real hold (reason shown beside Approved). These are layout evidence only, not a server result.
- Not shown: any TEST environment result. The harness has no real CPR/TB "not set up" state, so that case is proven only by the unit test and the stubbed screenshot.
