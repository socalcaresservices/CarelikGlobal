# Ogevia Pilot-to-Production Deployment Documentation

**Build:** `release/prd-v1`  
**Commit:** 3e322e9  
**Date:** 2026-10-07  
**Status:** Ready for execution

---

## 📋 Overview

This directory contains all documentation and scripts needed to deploy Ogevia from pilot (aws-fixes branch) to production (prd environment) following a 10-step deployment mission.

**All preparation work is complete.** Deployment is ready to execute sequentially by assigned teams.

---

## 🚀 Quick Start

### For AWS Infrastructure Team (Phase 4)
**Read:** See main repository CLAUDE.md or AWS deployment instructions  
**Execute:** CDK bootstrap and deploy 5 stacks  
**Time:** 10 minutes

### For Database Team (Phases 5-6)
**Start:** `DEPLOYMENT-PIPELINE-STATUS.md` (20-minute overview)  
**Execute:**
1. Run Phase 5: `bash phase-b-database-init.sh` OR follow `phase-b-manual-procedure.md`
2. Run Phase 6: Follow `phase-c-tenant-init-procedure.md`
3. Verify: Use `phase-b-checklist.md`

**Time:** 35 minutes total

### For QA Team (Phase 7)
**Follow:** `ogevia-prd-smoke-test.md` (10-step end-to-end test)  
**Time:** 30 minutes

### For Operations Team (Phases 8-9)
**Reference:** `DEPLOYMENT-PIPELINE-STATUS.md` sections 8-9  
**Time:** 20 minutes total

---

## 📁 File Guide

| File | Purpose | Audience |
|------|---------|----------|
| **DEPLOYMENT-PIPELINE-STATUS.md** | Complete pipeline overview, status, and checklist | All teams |
| **phase-b-database-init.sh** | Automated migration script | Database team |
| **phase-b-manual-procedure.md** | Step-by-step manual database setup | Database team |
| **phase-b-checklist.md** | Database verification and error handling | Database team |
| **phase-c-tenant-init-procedure.md** | Tenant/organization setup (7 steps) | Database team |
| **ogevia-prd-smoke-test.md** | QA test checklist (10 steps) | QA team |
| **ogevia-prd-config-required.txt** | Configuration requirements and checklist | All teams |
| **create-socalcare-org.sql** | SQL script for production organization | Database team |

---

## 🎯 Execution Order

```
PHASE 1-3 ✅ COMPLETE
    ↓
PHASE 4: AWS Infrastructure Deployment ← AWS Team starts here
    ↓
PHASE 5: Database Initialization ← DB Team (after Phase 4)
    ↓
PHASE 6: Tenant Setup ← DB Team (after Phase 5)
    ↓
PHASE 7: Smoke Test (10 steps) ← QA Team (after Phase 6)
    ↓
PHASE 8: CloudWatch Alarms ← Operations Team (after Phase 7 PASS)
    ↓
PHASE 9: DNS Cutover ← Operations Team (after Phase 8)
    ↓
✅ PRODUCTION LIVE
```

**Total time:** ~80 minutes active execution

---

## ✅ Pre-Execution Checklist

Before starting:

- [ ] AWS credentials configured (account 300094796789, us-west-2)
- [ ] RDS endpoint accessible (ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com)
- [ ] postgres master password available
- [ ] EC2 instance with Systems Manager Session Manager access
- [ ] psql command-line tool installed
- [ ] AWS CLI installed (for Phase 8-9)
- [ ] All team members reviewed their phase documentation

---

## 🔑 Key Resources

**Production Configuration:**
- AWS Account: 300094796789
- Region: us-west-2
- RDS Endpoint: ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
- Cognito User Pool: us-west-2_849AYz5J7
- Database: ogevia_prd (schema only, no data)
- Schema size: ~45 tables, ~25 RLS policies, ~30 audit triggers

**CDK Stacks (Phase 4 outputs):**
- Ogevia-prd-EvidenceStorage
- Ogevia-prd-NetworkEgress
- Ogevia-prd-WebHosting
- Ogevia-prd-ServiceVerificationApi
- Ogevia-prd-Observability

**Production URLs (after DNS cutover):**
- Web app: https://app.ogevia.com
- API: https://api.ogevia.com
- Cognito login: https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com

---

## 📊 Pipeline Status

| Component | Status | Notes |
|-----------|--------|-------|
| Source code | ✅ Tagged | release/prd-v1, commit 3e322e9 |
| Build | ✅ Verified | 677 tests pass, 0 errors |
| CDK synthesis | ✅ Generated | 5 templates, 143 KB total |
| Infrastructure deployment | ⏸️ Ready | Awaiting AWS team execution |
| Database setup | 🟡 Prepared | Scripts and procedures ready |
| Tenant initialization | 🟡 Prepared | SQL and verification queries ready |
| Smoke test | 🟡 Prepared | 10-step checklist ready |
| Monitoring | 🟡 Prepared | Alarm configs ready |
| DNS cutover | 🟡 Prepared | Route53 commands ready |

---

## ⚠️ Important Notes

### No Credentials in This Repository
- All sensitive values (passwords, API keys, etc.) are stored in AWS Secrets Manager
- Database credentials: `ogevia/database/app-prd`
- RDS master password: `rds!db-ogevia-prod-postgres`
- Cognito credentials: AWS Cognito User Pool console

### Rollback at Any Phase
- All CloudFormation stacks use RETAIN policy on data resources
- RDS snapshots created before each major phase
- Pilot environment remains unchanged
- DNS cutover reversible within 5 minutes

### Data Integrity
- No production data ingested until smoke test passes
- Test data (TEST-SMOKE-CLIENT, TEST-SMOKE-CAREGIVER) deleted after tests
- Audit trail immutable for all operations
- Cross-tenant data isolation enforced by RLS

---

## 🚨 Troubleshooting

| Issue | Reference |
|-------|-----------|
| Database migration fails | `phase-b-manual-procedure.md` → Troubleshooting section |
| RDS connection error | `phase-b-checklist.md` → Error Handling table |
| Smoke test step fails | `ogevia-prd-smoke-test.md` → Data Cleanup section |
| CloudWatch alarm won't fire | `DEPLOYMENT-PIPELINE-STATUS.md` → Phase 8 section |
| DNS cutover causing issues | `DEPLOYMENT-PIPELINE-STATUS.md` → Phase 9 section (rollback available) |

---

## 📞 Contact & Sign-Off

**Phase 4 (AWS Infrastructure):**
- Owner: [AWS Infrastructure Team]
- Expected completion: [Date/Time]
- Sign-off: [ ] Complete

**Phase 5-6 (Database & Tenant):**
- Owner: [Database Team]
- Expected completion: [Date/Time]
- Sign-off: [ ] Complete

**Phase 7 (Smoke Test):**
- Owner: [QA Team]
- Expected completion: [Date/Time]
- Result: [ ] 10/10 PASS

**Phase 8-9 (Monitoring & Cutover):**
- Owner: [Operations Team]
- Expected completion: [Date/Time]
- Sign-off: [ ] Production Live

---

## 📄 Related Documentation

**Repository architecture:** `/CLAUDE.md` (master build directive)  
**Operating record:** `/docs/OGEVIA_OPERATING_RECORD.md` (current state)  
**Operations PRD:** `/docs/OGEVIA_OPERATIONS_PRD.md` (product requirements)  
**CDK infrastructure:** `/infra/aws/` (TypeScript CDK code)  
**Migrations:** `/supabase/migrations/` (161 SQL files)  

---

**Deployment Status:** 🟡 STAGED & READY FOR EXECUTION

**Next step:** AWS Infrastructure Team executes Phase 4 CDK deployment

---

*This documentation was generated 2026-10-07 for the pilot-to-production deployment mission.*
*All files are current and synchronized with commit 3e322e9.*
