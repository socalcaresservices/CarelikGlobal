> **SUPERSEDED 2026-11-01 by the owner's approval of a different window (07:30 UTC start, reference `-C`; `DECISION_RECORD.md` A22). This proposal (10:00 UTC) was NOT applied and its `.PROPOSED` scripts must not be used.**

# PROPOSED amendment: an earlier start (prepared 2026-11-01 07:12 UTC) — NOT APPROVED, NOT APPLIED

**Nothing in this folder authorizes anything.** The recorded GO is unchanged: window **2026-11-01 17:00 UTC to 2026-11-02 02:00 UTC (09:00-18:00 PST)**, reference **`GO-0088-TEST-20261101-B`**, active scripts with hashes `5d8ea7d5…` / `ae1e789a…` (`PINS.md`). The files here are inert: the scripts carry the suffix `.PROPOSED` and are not read by any procedure. Nothing has run in AWS.

## 1. Options (the earlier start; the end stays 02:00 UTC unless you say otherwise)
Now: 2026-11-01 07:12 UTC (2026-11-01 00:12 PDT). US daylight time ends at 09:00 UTC today (clocks go from 02:00 PDT back to 01:00 PST), so local clock times around 01:00-02:00 occur twice; **everything below is exact in UTC**.
| Option | Start (UTC) | Start (PST) | End | Length | Notes |
|---|---|---|---|---|---|
| **1 (recommended)** | **2026-11-01 10:00** | **02:00 PST** (unambiguous: after the clock change) | 2026-11-02 02:00 UTC (18:00 PST) | 16 h | leaves about 2 h 45 min between this approval and the start for: my apply step (minutes), Stella receiving the message, rebuilding `/tmp` and re-verifying the hashes (about 15-30 min) |
| 2 | 2026-11-01 09:00 | 01:00 PST | same | 17 h | only 1 h 45 min of preparation; very tight |
| 3 | 2026-11-01 12:00 | 04:00 PST | same | 14 h | starts after the second month-start test rerun (scheduled 12:00 UTC); that rerun is **not** a gate (the same tests fail on the unmodified TEST line) |
Any other start is a one-line change: I regenerate the scripts with `fill_pins.py` and the hashes below change.

## 2. Reference
Recommended: **`GO-0088-TEST-20261101-C`**. Reason: the scripts require the exact reference, so a new reference makes any copy of the earlier scripts (which carry the 17:00 UTC start and `-B`) refuse to run, instead of leaving two valid-looking script sets. If you prefer to keep `-B` with new times, say so; the hashes then differ from the ones below and I regenerate.

## 3. What would change on approval (nothing else)
- Window constants and the approval reference in both scripts; **new script hashes**.
- `GO_DRAFT.md` section 1, `PINS.md`, `PHASE_C_COMMANDS.md`, `PHASE_C_RUN_SHEET.md`, the decision record (a new amendment A22) and the checklist banner.
- **Unchanged:** the GO text (including the `adopt` ledger write), the scope, the stop conditions, the commit `464dea64cb939c49fbca624b652f34b2863db2f2`, the waiver of the merge review, the gate and the SQL.

## 4. Proposed values for Option 1 with `-C` (generated and self-tested on a scratch copy; **not** the active scripts)
| Item | Value |
|---|---|
| Window | 2026-11-01 10:00:00 UTC to 2026-11-02 02:00:00 UTC |
| Reference | `GO-0088-TEST-20261101-C` |
| `STELLA_PHASE_C_DB.sh` (proposed) sha256 | `c692de986ba3c0b80904690735627e9e3a8b67cad1656d511bdc2956fa642599` |
| `STELLA_PHASE_C_DEPLOY.sh` (proposed) sha256 | `b1f0b9cbae08a13cfa82afed0cfe3f9c8e782b6890728ca09930885207ce5a42` |
| Gate / SQL | unchanged: `4e86f8d5…` / `9e54d9d4…` |
Self-test result: both scripts pass syntax checks and their selftests against the candidate checkout (window math 10:00 to 02:00 UTC, pins ok, `EXPECTED-ONLY: YES`, 250 routes).

## 5. Draft amendment text (for your approval)
> Amend the deployment window to **2026-11-01 10:00 UTC to 2026-11-02 02:00 UTC (02:00-18:00 PST)** and use reference **`GO-0088-TEST-20261101-C`**, superseding `GO-0088-TEST-20261101-B` and its window. All other terms, scope, stop conditions, commit `464dea64cb939c49fbca624b652f34b2863db2f2` and the waiver of the merge review remain unchanged.

To approve, reply with that text (or the option and reference you choose). Until then the recorded GO stands.

## 6. What Stella does after approval (and not before)
1. She is told the new window, reference and hashes; she **discards** any earlier copy of the scripts.
2. She follows section 0 of `PHASE_C_COMMANDS.md` (new checkout directory names are not needed; hashes in `PINS.md` are the new ones): tools and space, scripts checkout, application checkout at exactly `464dea64…`, install, selftests, `synth`.
3. From the start of the window she runs section 1 in order, one step at a time, pasting each output.
Her availability for the earlier time is **your** knowledge, not mine.
