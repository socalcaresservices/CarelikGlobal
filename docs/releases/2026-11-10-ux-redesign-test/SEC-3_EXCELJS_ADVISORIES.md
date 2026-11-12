> Current owner decisions (2026-11-10): Excel/ZIP parsing and exceljs are removed; the Excel-library options below are historical and require no selection. SEC-5 privacy is accepted as built. Duplicate merge stays OFF in both environments. CPR/TB remains one-click. Current evidence/commands: RELEASE_READINESS.md and TEST_DEPLOYMENT_PLAN.md. No new sign-off form is requested. The prepared DB script uses a TEST-only logical dump, refuses instance snapshots, and records migration checksums transactionally. Nothing deployed or applied to AWS.

# SEC-3: the exceljs dependency advisories (analysis and recommendation)

Prepared by Claude Code (AI assistant), 2026-11-11, from `pnpm audit --prod` run in `apps/sv-api` on the tree before the fix. **This is analysis. It is not security approval; the owner or a human reviewer decides.** Package under review: `exceljs@4.4.0` (the latest published version; there is no newer exceljs to upgrade to).

## 1. The advisories (9 audit entries, 6 distinct advisories)
The "eight" are the `brace-expansion` findings (five advisories, two of them reported for two installed versions). The ninth entry is `uuid`.
| # | Advisory | CVE | Severity | Package and installed version | Vulnerable | Patched | How it reaches us |
|---|---|---|---|---|---|---|---|
| 1 | GHSA-mh99-v99m-4gvg | CVE-2026-14257 | **High** | brace-expansion 1.1.16 | < 1.1.17 | 1.1.17 | exceljs > archiver 5.3.2 > archiver-utils > glob 7.2.3 > minimatch 3.1.5 |
| 2 | GHSA-rgw5-rvv9-x895 | CVE-2026-69152 | **High** | brace-expansion 1.1.16 | < 1.1.18 | 1.1.18 | same path |
| 3 | GHSA-qhr7-859c-m2p7 | CVE-2026-102278 | **High** | brace-expansion 1.1.16 | < 1.1.20 | 1.1.20 | same path |
| 4 | GHSA-qhr7-859c-m2p7 | CVE-2026-102278 | **High** | brace-expansion 2.1.4 | >= 2.0.0, < 2.1.6 | 2.1.6 | exceljs > archiver > readdir-glob 1.1.3 > minimatch 5.1.9 |
| 5 | GHSA-6j4f-fj2g-mc7p | CVE-2026-102276 | **High** | brace-expansion 1.1.16 | < 1.1.19 | 1.1.19 | glob path |
| 6 | GHSA-6j4f-fj2g-mc7p | CVE-2026-102276 | **High** | brace-expansion 2.1.4 | >= 2.0.0, < 2.1.5 | 2.1.5 | readdir-glob path |
| 7 | GHSA-q2hr-2g5m-vwhr | CVE-2026-102277 | Moderate | brace-expansion 1.1.16 | < 1.1.21 | 1.1.21 | glob path |
| 8 | GHSA-q2hr-2g5m-vwhr | CVE-2026-102277 | Moderate | brace-expansion 2.1.4 | >= 2.0.0, < 2.1.7 | 2.1.7 | readdir-glob path |
| 9 | GHSA-w5hq-g745-h8pq | CVE-2026-41907 | Moderate | uuid 8.3.2 | < 11.1.1 | 11.1.1 | exceljs > uuid (direct) |

What they are: #1 to #8 are denial-of-service flaws in how `brace-expansion` expands a brace pattern such as `{a,b}` (unbounded output or recursion causing an out-of-memory crash, a stack overflow, or slow quadratic expansion). #9 is a missing buffer bounds check in `uuid` versions 3, 5 and 6 when the caller passes an output buffer.

## 2. Exploitability in Ogevia (VERIFIED by code reading and by a run)
- **brace-expansion is only reached through glob matching** (`glob`, `readdir-glob`, `minimatch`), which `archiver` uses to add files by pattern when it **writes** an archive. exceljs references `archiver` only in `lib/stream/xlsx/workbook-writer.js` (the streaming writer). Ogevia only **reads** uploaded workbooks (`workbook.xlsx.load`, which uses `jszip`). No pattern string from an uploaded file, a sheet name, a cell or a file name is ever handed to a glob function.
- **Run:** a workbook whose sheet name and cells were `{a,b}{c,d}{e,f}`, `{1..9999999}` and nested braces was written and read back with exceljs while counting calls: **0 calls into brace-expansion** and **0 calls to uuid v3/v5/v6**.
- **uuid:** exceljs calls `uuid.v4()` with no buffer (the only use, `cf-rule-ext-xform.js`). The flaw is in v3/v5/v6 with a caller-supplied buffer, so exceljs does not use the vulnerable function.
- **Who could send a file at all:** only an authenticated agency administrator or owner (permission check in the database), through a route that is behind a release switch (off in production), with a 2 MB limit and the new zip-bomb guard (SEC-1).
- **Conclusion:** exploitability is **very low (not reachable by our use)**. The findings still make the audit report noisy, and a future code change could make the path reachable, so patching is cheap insurance.

## 3. Patches available (VERIFIED on the npm registry)
`brace-expansion` 1.1.21 and 2.1.7 exist and fix all of #1 to #8. `uuid` 11.1.1 (and 12.x, 13.x) fixes #9. exceljs itself has no newer release, so the fix is to force the patched versions of its dependencies.

## 4. Remediation options
| Option | Effect | Risk | Cost |
|---|---|---|---|
| **A (recommended): dependency overrides** in the root `package.json` (`brace-expansion` to ^1.1.21 and ^2.1.7, `uuid` to ^11.1.1) | Audit entries through exceljs go from 9 to **0** (checked) | Low: same exceljs, newer transitive versions. Checked: parser tests 10/10, import API tests 6/6, Lambda bundle still 1.13 MB and loads in about 160 ms | Done as a separate, revertible commit (`a709eb1`). Full CI on the release candidate is the final proof |
| B: accept as not reachable (document only) | Audit stays red for these 9 entries | None new today; future change could make it reachable | Zero |
| C: replace exceljs with a read-only XLSX parser | Removes the whole write/archive code from the bundle (smaller, fewer packages) | New code to write and test for a rarely used format | Several hours; owner approval for a new dependency |
| D: CSV only | Removes exceljs entirely | Office staff must save as CSV | Small |

**Recommendation: A now (already prepared), B documented as the reason it is low risk, revisit C only if XLSX use is rare.** Not applied on your behalf beyond preparing the commit; reverting it is `git revert a709eb1`.

## 5. Not part of this decision
The same audit lists high or moderate advisories in `react-router` (web), `zod` (shared) and `qs` via `stripe` (netlify functions). They are unrelated to exceljs and unchanged. Recommend a separate dependency-update change.

## 6. Decision (to be filled by a person)
☐ Accept option A ☐ Option B ☐ Option C ☐ Option D    Reviewer ____________ date ____________    **Security approval: NOT GIVEN.**
