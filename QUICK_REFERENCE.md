# Home Care Scheduling System - Quick Reference Guide

## Authorization Calculations

### Client Remaining Hours
```
Remaining Authorized Hours = Authorized Hours - Total Used Hours

Example:
Authorized: 160 hours
Used: 120 hours
Remaining: 40 hours
```

### Utilization Percentage
```
Utilization % = (Total Used Hours / Authorized Hours) × 100

Example:
Used: 120 hours
Authorized: 160 hours
Utilization: (120 / 160) × 100 = 75%
```

### Utilization Status
```
Active:        Utilization < 75%
Warning:       75% ≤ Utilization < 90%
At Risk:       90% ≤ Utilization < 100%
Max Reached:   Utilization ≥ 100%
```

### Scheduling Restriction
```
CANNOT schedule new visit if:
Remaining Authorized Hours ≤ 0

OR if adding new hours would exceed authorization:
Current Remaining - New Visit Hours < 0
```

---

## Coverage Score Formula

Used when a caregiver calls out to find the best replacement.

### Score Components

| Component | Points | Criteria |
|-----------|--------|----------|
| Availability Match | 40 | Caregiver available during shift time |
| Remaining Weekly Hours | 20 | Points = (Remaining Hours / Max Weekly Hours) × 20 |
| Service Area Match | 15 | Same service area as client |
| Client Experience | 15 | Has worked with client before |
| Certification Match | 10 | Has all required certifications |
| **TOTAL** | **100** | |

### Calculation Example

```
Scenario:
- Shift: 8am-2pm (6 hours)
- Client: Elderly Care, Service Area: North
- Required Certs: CNA

Candidate: Sarah Lee
- Available 8am-2pm on that day? YES → 40 points
- Has 12 hours remaining out of 40 max? (12/40)*20 = 6 points
- Service Area: North? YES → 15 points
- Worked with this client before? YES → 15 points
- Has CNA? YES → 10 points

TOTAL COVERAGE SCORE = 40 + 6 + 15 + 15 + 10 = 96 points
```

### Coverage Score Bands
```
90-100: Excellent match (Rank 1-3)
80-89:  Good match (Rank 4-7)
70-79:  Acceptable match (Rank 8-10)
< 70:   Poor match (Not recommended)
```

---

## Caregiver Capacity

### Remaining Weekly Hours
```
Remaining Hours = Max Weekly Hours - Currently Scheduled Hours

Example (Full-Time Caregiver):
Max Weekly Hours: 40
Currently Scheduled: 38
Remaining: 2 hours

Status: At capacity (overtime risk)
```

### Employment Status Guidelines

| Status | Max Weekly Hours | Notes |
|--------|------------------|-------|
| FT (Full-Time) | 40 | Standard 40-hour week |
| PT (Part-Time) | 24 | Typically 3-4 days/week |
| PRN (As-Needed) | 16 | On-call only, no guarantee |

### Overtime Risk Alert
```
Alert if: Currently Scheduled Hours ≥ Max Weekly Hours

Action:
- Notify manager
- Do not assign additional visits
- Monitor for call-out risk
```

---

## Call-Out Response Flowchart

```
Step 1: Caregiver calls out sick
        ↓
Step 2: Create CallOut record in SharePoint
        ↓
Step 3: Power Automate flow triggers automatically
        ↓
Step 4: Calculate Coverage Scores for available caregivers
        ↓
Step 5: Email sent to scheduler with Top 10 candidates
        ↓
Step 6: Scheduler contacts top candidate(s)
        ↓
Step 7: Update CallOut record with Replacement Caregiver
        ↓
Step 8: Status = "Filled" (flow updates automatically)
        ↓
DONE: Shift covered
```

---

## Authorization Renewal Timeline

### Tracking Expiration
```
Days Until Expiration = Authorization End Date - Today

Alert Schedule:
- 30 days before: Initial reminder
- 14 days before: Escalation notice
- 7 days before: Urgent renewal needed
- 0 days: EXPIRED (no scheduling allowed)
```

### Renewal Process
```
1. Client contacts agency with renewal authorization
2. Update Clients list:
   - AuthorizationEndDate = new date
   - AuthorizedHours = new amount
   - TotalUsedHours = 0 (if new cycle)
   - UtilizationPercent = 0
   - Status = "Active"
3. Verify all calculations update
```

---

## Visit Types & Recording

### Scheduled Visits
```
Definition: Planned, recurring visits

Recording:
- VisitType = "Scheduled"
- Assigned caregiver beforehand
- Must check client authorization remaining
- Counts toward client utilization

Example:
Client: Jane Doe
Caregiver: Sarah Lee
Date: 08-30-2026
Time: 9:00 AM - 11:00 AM (2 hours)
Type: Scheduled
```

### On-Call Visits
```
Definition: Emergency/unplanned visits

Recording:
- VisitType = "OnCall"
- May not have caregiver pre-assigned
- Still counts toward client utilization
- Use for coverage/replacement visits

Example:
Client: John Smith
Caregiver: Mike Brown (replacement)
Date: 08-30-2026
Time: 2:00 PM - 3:00 PM (1 hour)
Type: OnCall
Reason: Original caregiver called out
```

---

## Common Calculations in Power BI

### Measure: Total Authorized Hours
```DAX
Total Authorized Hours = SUM(Clients[AuthorizedHours])
```

### Measure: Total Used Hours
```DAX
Total Used Hours = SUM(Clients[TotalUsedHours])
```

### Measure: Overall Utilization
```DAX
Overall Utilization % = 
DIVIDE(
    SUM(Clients[TotalUsedHours]),
    SUM(Clients[AuthorizedHours])
) * 100
```

### Measure: Caregivers Over Capacity
```DAX
Caregivers at Risk = 
COUNTIF(
    Caregivers[CurrentScheduledHours],
    ">=" & Caregivers[MaxWeeklyHours]
)
```

### Measure: Coverage Success Rate
```DAX
Coverage Success Rate = 
DIVIDE(
    COUNTIF(CallOuts[Status], "Filled"),
    COUNTIF(CallOuts[Status], "*")
) * 100
```

---

## SharePoint Formula Reference

### In Calculated Columns

**Calculate Hours from Time Range:**
```
=(EndTime - StartTime) * 24
```

**Subtract Two Numbers:**
```
=MaxWeeklyHours - CurrentScheduledHours
```

**Calculate Percentage:**
```
=(TotalUsedHours / AuthorizedHours) * 100
```

**Check If Remaining Is Available:**
```
=IF(RemainingAuthorizedHours > 0, "Available", "Not Available")
```

---

## Key Threshold Values

| Metric | Yellow Alert | Orange Alert | Red Alert |
|--------|--------------|--------------|-----------|
| Authorization Used | 75% | 90% | 100%+ |
| Caregiver Hours | 85% capacity | 95% capacity | 100%+ |
| Open Shift Duration | 5+ days | 10+ days | 14+ days |
| Coverage Success | 85% | 80% | < 80% |

---

## Alert Email Recipients

### Authorization Alerts
- Scheduler
- Program Manager
- Finance (for 100% alerts)

### Call-Out Alerts
- Scheduler
- Shift Supervisor
- On-Call Backup (if applicable)

### Open Shift Alerts
- Scheduler
- Program Manager

### Weekly Utilization Report
- Management Team
- Program Directors
- Finance Department

---

## Data Entry Checklist

### When Adding a New Caregiver
- [ ] First Name
- [ ] Last Name
- [ ] Phone Number (format: (XXX) XXX-XXXX)
- [ ] Status (FT/PT/PRN)
- [ ] Service Area
- [ ] Hire Date
- [ ] Max Weekly Hours
- [ ] Certifications (comma-separated)
- [ ] Active = Yes

### When Adding a New Client
- [ ] Client Name
- [ ] Program Type
- [ ] Service Area
- [ ] Authorization Start Date
- [ ] Authorization End Date
- [ ] Authorized Hours
- [ ] Status = "Active"

### When Creating a Visit
- [ ] Client ID (required)
- [ ] Caregiver ID (required)
- [ ] Visit Date (required)
- [ ] Start Time (required)
- [ ] End Time (required)
- [ ] Visit Type (Scheduled or OnCall)

### When Recording a Call-Out
- [ ] Call-Out Date (today's date)
- [ ] Caregiver ID (who called out)
- [ ] Shift Start Time
- [ ] Shift End Time
- [ ] Reason (Sick/Emergency/Other)
- [ ] Client ID (affected client)
- [ ] Check email for replacement suggestions

---

## Troubleshooting Quick Tips

| Issue | Cause | Solution |
|-------|-------|----------|
| Can't create visit | Client authorization exhausted | Check RemainingAuthorizedHours > 0 |
| Can't create visit | Caregiver over hours | Check CurrentScheduledHours < MaxWeeklyHours |
| Alert not sent | Utilization not reached | Verify TotalUsedHours was updated |
| Wrong replacements | Caregiver unavailable | Check CaregiverAvailability for that day |
| Old data in Power BI | Not refreshed | Click "Refresh" or check scheduled refresh |
| Hours show as negative | Date/time calculation error | Verify StartTime < EndTime |

---

## Glossary

- **Authorized Hours:** Total hours approved for a client in their authorization period
- **Utilization:** Percentage of authorized hours that have been used
- **Call-Out:** When a scheduled caregiver is unable to work their shift
- **Coverage:** Replacement caregiver assigned to cover a call-out
- **Coverage Score:** Ranking system (0-100) to find best replacement caregiver
- **Open Shift:** A scheduled visit with no assigned caregiver
- **Overtime Risk:** When a caregiver is scheduled for more than their max weekly hours

