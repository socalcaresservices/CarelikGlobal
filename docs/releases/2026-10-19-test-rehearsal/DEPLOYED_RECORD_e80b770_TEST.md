# TEST deployment record: code commit e80b770 (PATH B, ledger 85/0085)

Recorded 2026-10-19 from operator-pasted CloudShell output. TEST only. No production change. Implemented, tested and deployed to TEST; owner acceptance (Step 14) NOT yet reported.

| Item | Value | Evidence |
|---|---|---|
| Code commit deployed | e80b770210c54e423d28ecf48e00f1dda9506cec | BUILD_INFO code_commit; served bundle `VITE_APP_VERSION` |
| Tarball sha256 | 8e65487e74f3d94122042606db4bf56fed98fc3f02bf31f44f3995fa1f4cbd3e | record-deployed.sh |
| Web | https://d2xumch5w0izfg.cloudfront.net | local, CloudFront and S3 index.html sha256 all 61d2c64af493dce375a953eeec9cdbbdbe880fe3bed7e1cc7757820b284bb2fd; VITE_APP_ENV "test"; config.json unchanged |
| API | https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com | Ogevia-prod-ServiceVerificationApi UPDATE_COMPLETE; Handler asset eab95a809b3b...; Lambda CodeSha256 eVI1ZdrlczUxN/+sZlOxf8fKHjh2GTe+t9HFGEz5qlo= (hex 79523565dae573353137ffac6653b17fc7ca1e38761937beb7d1c5184cf9aa5a); LastModified 2026-10-19T21:34:51Z |
| Database | 85 migrations, latest 0085, enforcement active for 0 of 0 agencies | Step 16 (21:58Z); security group sg-00530a1f4f7648e65 restored, rule-set sha256 76e9c75367c204f0... |
| Pre-deploy snapshot | ogevia-prod-postgres-pre-0085-202610192111 (available, manual, encrypted) | snapshot-verify.sh verify |
| ComplianceSweep | ENABLED; 15-minute entries 20:08Z-21:53Z all zero (organizations 0, evaluated 0, failedOrganizations 0), including 21:38Z and 21:53Z after the 21:34:51Z Lambda update | Step 15; log group Ogevia-prod-ServiceVerificationApi-HandlerLogGroup881018CA-MkXDAX4WQkVB |
| Smoke | API rejects anonymous calls; web serves the app with security headers | deploy-test-slice.sh smoke |
| NetworkEgress | not deployed (PATH B); gate showed no difference except the ignored ogevia:deployment-status tag | Step 8 |

## Procedure defects found (no deployed artifact affected)
1. `web-verify.sh` hashes index.html through a shell variable, which drops the trailing newline, so its index.html comparison always FAILs (served and local bytes are identical; checked directly). `record-deployed.sh` calls it, so it printed `FAIL web verification failed` and `STOP: an artifact does not map to the approved commit`, and did not print `RECORDED`. Every other mapping line passed.
2. Step 15 assumed log group `/aws/lambda/<function>`; the Handler uses an explicit CDK log group. The group is read from `LoggingConfig.LogGroup`.

## Warnings
- BUILD_INFO `approval_ref` is `APPROVAL-REF-PENDING-OWNER` while the stack tag carries `approved-owner-go-test-20261019-02`. **RESOLVED (owner statement, 2026-10-20):** the authoritative TEST approval reference is `owner-go-test-20261019-02`; the `APPROVAL-REF-PENDING-OWNER` value in the TEST tarball's BUILD_INFO is a placeholder and is NOT authoritative. The tarball (sha256 `8e65487e...cbd3e`) is left unchanged so its hash and this record stay valid. The production reference is separate: `owner-go-prd-20261020-01`.
- Extra manual snapshot ogevia-prod-postgres-pre-0085-202610190330 (origin unknown) left untouched.
- NOT VERIFIED on TEST: calendar current-authorization rule, UX density changes, Billing Review Approve visibility, Care Team, Compliance chips, Schedule header, document upload/approve, caregiver visit flow. Production NO-GO; real PHI NO-GO (BAA).

## Step 14 acceptance (OWNER-REPORTED 2026-10-19; not independently observed by the engineer)
Workflow rows 1-8: PASS (upload; self-approval blocked; second-user approval; download/open; approval survives sign-out/in; badge counts match; shift limit validation; visit start/end/client confirmation).
UI checks 1-6: PASS (calendar current-authorization rule; Home density; Billing Review Approve visible; Care Team list before add form; Compliance status chips; Schedule single header).
Observation (not a blocker): Reports still feel somewhat crowded.
Owner decision: TEST accepted; Step 14 signed off. Production remains NO-GO (no production GO requested or given).
Steps 15, 16 and 17 completed as recorded above (Step 17's script FAIL is the web-verify.sh defect).
