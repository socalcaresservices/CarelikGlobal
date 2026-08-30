# Power Automate Flows - Setup Guide

## Overview
These flows automate critical workflows for the Home Care Scheduling System.

---

## FLOW 1: Authorization Alert Notifications

**Purpose:** Alert schedulers when clients reach 75%, 90%, or 100% of authorized hours

**Trigger:** When an item is modified in Clients list

**Condition Check:**
```
UtilizationPercent >= 75
```

**Actions:**

### Step 1: Check Utilization Level
```
If UtilizationPercent < 75
  Do nothing (end flow)

Else If UtilizationPercent >= 75 AND UtilizationPercent < 90
  Alert Level = "Yellow" (75%)

Else If UtilizationPercent >= 90 AND UtilizationPercent < 100
  Alert Level = "Orange" (90%)

Else If UtilizationPercent >= 100
  Alert Level = "Red" (100%)
```

### Step 2: Send Email Alert

**Recipient:** Scheduler/Manager
```
Email Subject: [ALERT] Client Authorization - {ClientName}

Email Body:
---
AUTHORIZATION UTILIZATION ALERT

Client: {ClientName}
Program: {ProgramType}
Service Area: {ServiceArea}

Authorized Hours: {AuthorizedHours}
Used Hours: {TotalUsedHours}
Remaining Hours: {RemainingAuthorizedHours}
Utilization: {UtilizationPercent}%

Alert Level: {Alert Level}
Authorization Valid Until: {AuthorizationEndDate}

Action Required:
- If at 100%, no new visits can be scheduled
- Review upcoming visits and plan for renewal
- Contact client for authorization extension if needed

---
```

### Step 3: Update Client Record

Set Status field:
```
If UtilizationPercent < 75
  Status = "Active"
Else If UtilizationPercent >= 75 AND UtilizationPercent < 100
  Status = "Warning"
Else If UtilizationPercent >= 100
  Status = "Max Reached"
```

### Step 4: Log Notification in SharePoint

Create item in "AlertLog" list:
- AlertType: "Authorization"
- ClientID: {ClientID}
- UtilizationLevel: {UtilizationPercent}
- AlertDate: Now()
- Status: "Sent"

---

## FLOW 2: Caregiver Call-Out Workflow

**Purpose:** When a caregiver calls out, find best replacements using Coverage Score

**Trigger:** When an item is created in CallOuts list

**Parallel Actions:**

### Step 1: Calculate Available Caregivers
```
Filter Caregivers where:
  - Active = Yes
  - Status = "FT" OR "PT" (exclude PRN for initial ranking)
  - CurrentScheduledHours < MaxWeeklyHours
  - ServiceArea = Client.ServiceArea
```

### Step 2: Check Availability for Shift Time
```
Get all CaregiverAvailability records where:
  - CaregiverID in {Available Caregivers}
  - DayOfWeek = CallOut.CallOutDate (day)
  - AvailableStartTime <= CallOut.ShiftStart
  - AvailableEndTime >= CallOut.ShiftEnd
```

### Step 3: Calculate Coverage Score for Each Match

**Formula Components:**
```
Availability Match = 40 points (if available during shift)

Remaining Weekly Hours = 20 points
  Calculation: (RemainingHours / MaxWeeklyHours) * 20
  Example: If 10 hours left out of 40 = (10/40)*20 = 5 points

Service Area Match = 15 points (if same area)

Client Experience = 15 points (if previously worked with client)
  Check: Is CaregiverID in Visits where ClientID = {CallOutClientID}?

Certification Match = 10 points (if has required certifications)
  Check: Does caregiver have all Client's required certifications?

TOTAL COVERAGE SCORE = Sum of all components
```

### Step 4: Rank Replacements
```
Sort caregivers by:
  1. Coverage Score (Descending)
  2. RemainingHours (Descending)
  3. Years of Experience (Descending)

Return Top 10 candidates
```

### Step 5: Notify Scheduler

**Send Email with Recommendations:**
```
Email Subject: CALL OUT - Replacement Needed for {ClientName}

Email Body:
---
CAREGIVER CALL OUT - REPLACEMENT NEEDED

Original Caregiver: {CaregiverName}
Client: {ClientName}
Date: {CallOutDate}
Shift: {ShiftStart} - {ShiftEnd}
Call Out Reason: {Reason}

TOP REPLACEMENT CANDIDATES:
---

| Rank | Name | Coverage Score | Hours Available | Service Area | Phone |
|------|------|-----------------|-----------------|--------------|-------|
| 1 | {Name} | {Score} | {Hours} | {Area} | {Phone} |
| 2 | {Name} | {Score} | {Hours} | {Area} | {Phone} |
| ... | ... | ... | ... | ... | ... |
| 10 | {Name} | {Score} | {Hours} | {Area} | {Phone} |

ACTION REQUIRED:
Contact top candidates and assign replacement to CallOuts.ReplacementCaregiverID

---
```

### Step 6: Update Call-Out Status
```
If replacement assigned immediately:
  Status = "Filled"
  Set ReplacementCaregiverID

Else:
  Status = "Open"
  Send daily reminder until filled
```

---

## FLOW 3: Open Shift Alert

**Purpose:** When a visit becomes unassigned, find available caregivers

**Trigger:** When an item is modified in Visits list AND CaregiverID becomes empty

**Actions:**

### Step 1: Get Client Details
```
Get Client information from Clients list
  - ServiceArea
  - AuthorizedHours
  - RemainingAuthorizedHours
  - Required Certifications
```

### Step 2: Validate Scheduling is Still Allowed
```
If RemainingAuthorizedHours <= 0
  Send alert: "Cannot fill open shift - client has no remaining hours"
  End flow
```

### Step 3: Find Available Caregivers
```
Query Caregivers where:
  - Active = Yes
  - ServiceArea = Client.ServiceArea
  - CurrentScheduledHours < MaxWeeklyHours
```

### Step 4: Check Availability
```
Filter to caregivers available on VisitDate
  between VisitStartTime and VisitEndTime
```

### Step 5: Calculate Coverage Score
```
Apply same Coverage Score formula as Flow 2:
  - Availability Match (40 points)
  - Remaining Hours (20 points)
  - Service Area Match (15 points)
  - Client Experience (15 points)
  - Certification Match (10 points)
```

### Step 6: Notify Scheduler

**Send Email:**
```
Email Subject: OPEN SHIFT - {ClientName} on {VisitDate}

Email Body:
---
OPEN SHIFT AVAILABLE

Client: {ClientName}
Date: {VisitDate}
Time: {StartTime} - {EndTime}
Service Area: {ServiceArea}

RECOMMENDED CAREGIVERS:
(Ranked by Coverage Score)

| Rank | Name | Coverage Score | Available Hours | Certifications | Phone |
|------|------|-----------------|-----------------|-----------------|-------|
| 1 | {Name} | {Score} | {Hours} | ✓ | {Phone} |
| 2 | {Name} | {Score} | {Hours} | ✓ | {Phone} |

ACTION REQUIRED:
Assign caregiver to Visit.CaregiverID

---
```

---

## FLOW 4: Automated Shift Conflict Prevention

**Purpose:** Prevent double-booking and over-hour scheduling

**Trigger:** Before a visit item is created or modified

**Validation Checks:**

```
1. Caregiver Double-Booking Check:
   Does CaregiverID have another visit at the same time?
   If YES → Block and notify

2. Client Authorization Check:
   RemainingAuthorizedHours > Hours for new visit?
   If NO → Block with message

3. Caregiver Weekly Hour Limit:
   CurrentScheduledHours + New Visit Hours <= MaxWeeklyHours?
   If NO → Warn (allow with approval, or deny)

4. Caregiver Availability Check:
   Is caregiver available during this time?
   If NO → Block with available times

5. Certification Check:
   Does caregiver have required certifications for client?
   If NO → Block and list required certs
```

---

## FLOW 5: Weekly Utilization Report

**Purpose:** Generate utilization summaries for management review

**Trigger:** Scheduled daily at 6 AM (or weekly on Monday)

**Actions:**

### Step 1: Calculate Caregiver Metrics
```
For each caregiver:
  - Total hours scheduled this week
  - Total hours available
  - Utilization percentage
  - Remaining capacity
  - Overtime status (if exceeding MaxWeeklyHours)
  - Call-out count this week
```

### Step 2: Calculate Client Metrics
```
For each client:
  - Total hours used this week
  - Cumulative utilization %
  - Visits completed
  - Remaining authorized hours
  - Authorization expiration date
  - On-track status
```

### Step 3: Identify Risks
```
Flag:
  - Caregivers exceeding weekly hours (overtime risk)
  - Clients at 90%+ utilization (renewal needed soon)
  - Clients at 100% (no capacity for new visits)
  - Open call-outs not yet filled
  - Understaffed periods
```

### Step 4: Send Summary Report

**Send Excel via Email:**
- Caregiver Utilization Sheet
- Client Authorization Sheet
- Risk Summary Sheet
- Open Shift Summary

---

## Implementation Checklist

- [ ] Verify all SharePoint lists are created
- [ ] Test Flow 1: Create a client and update utilization to 75%
- [ ] Test Flow 2: Create a call-out record and verify email
- [ ] Test Flow 3: Leave a visit without caregiver assigned
- [ ] Test Flow 4: Try to create conflicting visits
- [ ] Test Flow 5: Schedule flow and verify report
- [ ] Train schedulers on workflow
- [ ] Set up alert email recipients
- [ ] Configure Power BI data refresh

---

## Common Issues & Solutions

**Issue:** Flow not triggering
- Check trigger condition is correct
- Verify list item actually changed
- Review flow run history for errors

**Issue:** Emails not sending
- Verify recipient email is valid
- Check Power Automate has permission to send emails
- Review approval settings

**Issue:** Coverage Score calculation incorrect
- Verify all lookup fields are populated
- Check formula syntax in flow
- Test with known values first

