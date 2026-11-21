# Read-only production dry run: pins and scope (written 2026-11-01 15:16 UTC)

**Owner approval (2026-11-01, in conversation): "Approve the read-only dry run."** This is NOT a GO and does not authorize any release step. Scope: ONE run each of `synth`, `capture` and `check` (`STELLA_PRD_DEPLOY.sh`) and `probe` (`STELLA_PRD_DB.sh`) against production, to prove the new access path and read production's live API template with the new gate. The owner did not state a reference or a window; **these were proposed by Claude** and can be changed by re-filling.
| Pin | Value |
|---|---|
| Dry-run approval reference | `PRD-DRYRUN-20261101` |
| Window (UTC) | 2026-11-01 15:15:00 to 2026-11-01 19:15:00 |
| Application commit (checkout for `REPO`; the scripts' pin) | `63374f7ace290ec680cf0c4a34251b9a2f439006` |
| Handler / Identity code asset keys (from the synthesized production assembly) | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7` / `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759` |
| Migration pins (0088; all-88 set; 0086-0088 rollback set) | `dc20f327...`; `049c52cb...`; `4b53cb19...` (not used by the dry run) |
**sha256 of the dry-run copies (verify before running):**
```
fb96c26ee291f09b362c5f1e00c18e199921d09c19617e3f55a7de61942d9482  STELLA_PRD_DB.sh
0799388adab1be7b199fa1efdf0741dcf3e6749b68088734e2db5d3f2b021069  STELLA_PRD_DEPLOY.sh
05db104472a7934eec695eb7b026d3179de9ab4a9581ff7001a1854b726f9830  STELLA_PRD_READONLY.sql
e905e7b751e0998d5c240be58fd39710fbe411991321d014e47ddb97c80b7a26  diff_gate_prd0088.py
```
**These copies differ from the release scripts in two ways only:** the placeholders are filled with the values above, and the mode lists are cut down so the approval scope is enforced by the files: the DB copy accepts only `selftest`, `probe` and `--restore-only`; the deploy copy accepts only `selftest`, `synth`, `capture` and `check` (every other mode prints "DRY-RUN COPY: ... refused" before any tool or AWS call). They must never be used for the release: the final scripts are filled again from the owner's GO, with a different hash.
**What each step does in AWS:** `synth` nothing (local build of the CloudFormation assembly); `capture` reads only (CloudFormation templates and outputs, Lambda configuration, API Gateway routes, S3 object metadata, a download of the production web bucket into the operator's home, an HTTP GET of the production site); `check` reads the live API template and compares; `probe` adds ONE temporary inbound rule on the RDS security group from the admin host's own /32, reads the RDS master secret into memory, runs read-only SELECTs on `ogevia_prd`, removes the rule and proves the group identical (the pattern the owner approved for production on 2026-11-01). No database write, no stack change, no email.
**Results go to `docs/aws/PRODUCTION_DRYRUN_2026-11-01.md`; the gate's allow-list is corrected from them before any GO.**

**Revision (2026-11-01 16:10 UTC):** the gate file `diff_gate_prd0088.py` was re-issued: it now prints WHAT differs for every changed resource (the first `check` of the dry run stopped on the API resource and the old gate did not say why). The verdict logic is unchanged; the other three files are unchanged. The previous gate hash was `44676ef6...`.

**Revision 2 (2026-11-01):** the deploy copy and the gate were re-issued: the gate now has `--allow-cors-add` (only the two CORS origins the dry run found missing from the live API template, only in `pre`). Previous hashes: deploy `6c8d0303...`, gate `99e06b48...` (and `44676ef6...` before that). DB copy and SQL unchanged.
