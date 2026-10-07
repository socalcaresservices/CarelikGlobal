# Ogevia Production (PRD) Smoke Test Checklist

**Environment:** Production (prd)  
**Database:** ogevia_prd  
**Date:** 2026-10-07  
**Tester:** Ogevia Admin Team  

---

## PREREQUISITE: Environment Ready

- [ ] ogevia_prd database created and accessible
- [ ] All 153 migrations applied successfully
- [ ] Organization: SoCal Care Services (active)
- [ ] Admin user: admin@ogevia.com (owner role)
- [ ] Admin user: Logged in successfully
- [ ] App: https://app.ogevia.com loads
- [ ] API: https://<api-id>.execute-api.us-west-2.amazonaws.com/v1/health returns 200

---

## TEST SEQUENCE

### TEST 1: Admin Login
**Step:** Open https://app.ogevia.com  
**Expected:** Cognito login page appears  
**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 2: Create Fake Client (TEST-SMOKE-CLIENT)
**Step:** Admin Dashboard → Clients → Add Client  
**Fields:**
- First Name: TEST-SMOKE
- Last Name: CLIENT
- Code: TSC-001
- Status: Active

**Expected:** Client created, appears in client list  
**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 3: Create Authorization
**Step:** Click client → Authorizations → Add  
**Fields:**
- Service Type: Personal Care
- Start Date: 2026-10-07
- End Date: 2026-10-14
- Hours: 20 (per week)

**Expected:** Authorization saved, hours show in client card  
**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 4: Create Schedule
**Step:** Clients → TEST-SMOKE → Schedule → Add  
**Fields:**
- Date: 2026-10-08 (tomorrow)
- Time: 09:00 - 17:00
- Service: Personal Care
- Status: Scheduled

**Expected:** Shift appears in calendar  
**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 5: Assign Caregiver
**Step:** Shift → Assign → Choose Caregiver  
**Note:** Use TEST-SMOKE-CAREGIVER if available, or create fake one

**Expected:** Caregiver assigned, shift shows assignment  
**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 6: Caregiver Start Visit
**Step:** Login as TEST-SMOKE-CAREGIVER → Scheduled Shifts → Click shift  
**Action:** Click "Start Service"  
**Fields:**
- Confirm location
- Confirm client present

**Expected:** 
- Time In timestamp recorded (server time)
- Status changes to "In Progress"

**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 7: Caregiver End Visit
**Step:** Active Shift → Click "End Service"  
**Action:** Confirm service completed

**Expected:**
- Time Out timestamp recorded (server time)
- Duration calculated: 8 hours 0 minutes
- Status changes to "Awaiting Confirmation"

**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 8: Client Confirm Visit
**Step:** TEST-SMOKE-CLIENT login → Pending Confirmations  
**Action:** Review visit → Confirm (or adjust)  
**Fields:**
- Start time: (auto-filled, can adjust)
- End time: (auto-filled, can adjust)
- Notes: (optional)

**Expected:**
- Visit marked "Confirmed"
- Signature/approval recorded
- Visit status → "Submitted"

**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 9: Billing Ready State
**Step:** Admin → Client Operations → TEST-SMOKE-CLIENT  
**Check:** Visit appears with status "Submitted"  
**Action:** Admin clicks "Approve for Billing"

**Expected:**
- Visit status: "Billing Ready"
- Timestamp: Approval recorded
- Hours deducted from authorization (20 - 8 = 12 remaining)

**Result:** ☐ PASS ☐ FAIL  
**Notes:**

### TEST 10: Tenant Isolation Verification
**Step:** Login as DIFFERENT admin user (if available) or check RLS  
**Verify:** TEST-SMOKE-CLIENT data NOT visible to other organizations

**Expected:**
- Other org's admin sees only their own clients
- RLS policy enforced at database layer
- No cross-tenant data leakage

**Result:** ☐ PASS ☐ FAIL  
**Notes:**

---

## DATA CLEANUP (Run after tests pass)

**Delete test data:**

```sql
DELETE FROM public.service_visits WHERE visit_number LIKE 'TEST-%';
DELETE FROM public.shifts WHERE id IN (
  SELECT s.id FROM shifts s
  JOIN clients c ON s.client_id = c.id
  WHERE c.code = 'TSC-001'
);
DELETE FROM public.client_authorizations WHERE client_id IN (
  SELECT id FROM clients WHERE code = 'TSC-001'
);
DELETE FROM public.clients WHERE code = 'TSC-001';

-- Delete test caregiver (if created)
DELETE FROM public.caregiver_records WHERE caregiver_code LIKE 'TEST-%';

-- Verify cleanup
SELECT COUNT(*) AS remaining_test_records FROM clients 
UNION ALL SELECT COUNT(*) FROM shifts 
UNION ALL SELECT COUNT(*) FROM service_visits;
```

---

## FINAL VERIFICATION

- [ ] All 10 tests PASSED
- [ ] Test data cleaned up
- [ ] No error logs in CloudWatch
- [ ] API response times < 500ms
- [ ] Database CPU < 40%
- [ ] No RLS violations logged

---

## SIGN-OFF

| Role | Name | Date | Status |
|------|------|------|--------|
| Tester | __________ | __________ | PASS / FAIL |
| Reviewer | __________ | __________ | APPROVED / REJECTED |

---

## NOTES & ISSUES

(Attach any error logs, screenshots, or issues found)

