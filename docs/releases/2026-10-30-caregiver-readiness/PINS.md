# Pins for the integrated candidate (filled 2026-11-01 from the owner's window and GO reference; verify before use)

**AMENDED 2026-11-01 (A22): GO reference `GO-0088-TEST-20261101-C`.** **Window: 2026-11-01 07:30 UTC to 2026-11-02 02:00 UTC = 2026-11-01 00:30 PDT to 2026-11-01 18:00 PST** (US daylight time ends at 09:00 UTC on 2026-11-01: the window opens in PDT and closes in PST; use UTC). This **supersedes** `GO-0088-TEST-20261101-B` (window 17:00 UTC to 02:00 UTC, script hashes `5d8ea7d5…` / `ae1e789a…`), the first filling (`GO-0088-TEST-20261101`, 2026-11-02 window, hashes `e313673f…` / `29b674bb…`) and the proposed 10:00 UTC start: do not use those. The GO is given (A20/A22); these pins make the scripts runnable only inside this window.

| Item | Value |
|---|---|
| Application commit (only approved deployment commit) | `464dea64cb939c49fbca624b652f34b2863db2f2` |
| `STELLA_PHASE_C_DB.sh` sha256 | `d2195de4463c6586407e0f41a4acb51494da72c9505b3be63e1ecb270284a7d2` |
| `STELLA_PHASE_C_DEPLOY.sh` sha256 | `69ecbdd3c4648da1fbcbf16b2efd861c4b99bd514cc402f2fc2a502a6a072b0c` |
| `diff_gate_0086.py` sha256 | `4e86f8d590f389faa72dd5d18250ef4246312f47b2d8b9b662a9d59484f27601` |
| `STELLA_READONLY_VERIFICATION.sql` sha256 | `9e54d9d47b1639b1b1ad078e009b26e9392a6ab82ff8073336030f0e84868ca7` |
| Migration `0088_caregiver_readiness_approve_for_work.sql` | `dc20f327794a6f9b6e4f79d201550f1d0a9970e2e4b800c27b598213c82cf34f` |
| Rollback `0088_...down.sql` | `693039a5ce9dcc9682cbb13a469041d63dc5e39b46b739c70412b2469876badd` |
| Staff `0086_staff_management.sql` / `0087_staff_invitation_acceptance.sql` (bytes already on TEST) | `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f` / `f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88` |
| Migrations 0001-0085 set | `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` |
| Migrations 0001-0087 set | `873d258368c47e16a4c3d861c7d53a7245ca9ddeea788c04d7509768c069d237` |
| All 88 migration files | `049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c` |
| Rollback set 0088 (one file) | `652df67f55c98a044485c6fa7200c62a3d586ab049fa4407e134d692920e3d5b` |
| Handler code asset (synth) | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7.zip` |
| IdentityHandler code asset | `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` (unchanged) |
| API routes in the assembly | 250 |
| Live Handler asset today (captured 2026-10-31; equals the TEST line's) | `2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip`; Lambda `CodeSha256` before: `VFN/cMO326y63xaTOQERNhyvp+mHC19EM3/xN4IWeE4=` |
