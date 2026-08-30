# Home Care Scheduling System - SharePoint Setup Guide

## Overview
This guide provides step-by-step instructions to create SharePoint lists for the Home Care Scheduling and Authorization Management System.

## Prerequisites
- SharePoint Online access
- Appropriate permissions to create lists
- Power Automate licenses
- Power BI licenses (for dashboards)

---

## SharePoint Lists Setup

### 1. CAREGIVERS List

**Purpose:** Manage caregiver profiles and availability

**Steps:**
1. In SharePoint, select **+ New** > **List**
2. Choose **Blank list**
3. Name: `Caregivers`
4. Add the following columns:

| Column Name | Type | Required | Notes |
|---|---|---|---|
| CaregiverID | Single line of text | Yes | Primary identifier |
| FirstName | Single line of text | Yes | |
| LastName | Single line of text | Yes | |
| PhoneNumber | Single line of text | No | Format: (XXX) XXX-XXXX |
| Status | Choice | Yes | FT, PT, PRN |
| ServiceArea | Choice | Yes | Home Health, Elderly Care, etc. |
| HireDate | Date | Yes | |
| MaxWeeklyHours | Number | Yes | Default: 40 |
| CurrentScheduledHours | Number | No | Auto-calculated |
| RemainingHours | Number | No | Auto-calculated |
| Certifications | Multiple lines of text | No | Comma-separated |
| PreferredClients | Multiple lines of text | No | Comma-separated |
| Active | Yes/No | Yes | Default: Yes |

**SharePoint Formula (Calculated Column):**
```
=MaxWeeklyHours - CurrentScheduledHours
```

---

### 2. CAREGIVER AVAILABILITY List

**Purpose:** Track available shifts for each caregiver

**Steps:**
1. Create new list named `CaregiverAvailability`
2. Add columns:

| Column Name | Type | Required | Notes |
|---|---|---|---|
| AvailabilityID | Single line of text | Yes | Format: AUTO-GENERATE |
| CaregiverID | Lookup | Yes | Links to Caregivers |
| DayOfWeek | Choice | Yes | Mon-Sun |
| AvailableStartTime | Time | Yes | |
| AvailableEndTime | Time | Yes | |
| AvailableHours | Number | No | Auto-calculated |

**SharePoint Formula (Calculated Column):**
```
=(AvailableEndTime - AvailableStartTime)*24
```

---

### 3. CLIENTS List

**Purpose:** Track client information and authorization hours

**Steps:**
1. Create new list named `Clients`
2. Add columns:

| Column Name | Type | Required | Notes |
|---|---|---|---|
| ClientID | Single line of text | Yes | Primary identifier |
| ClientName | Single line of text | Yes | |
| ProgramType | Choice | Yes | Home Health, Personal Care, etc. |
| ServiceArea | Choice | Yes | Same as Caregiver areas |
| AuthorizationStartDate | Date | Yes | |
| AuthorizationEndDate | Date | Yes | |
| AuthorizedHours | Number | Yes | Total authorized hours |
| TotalUsedHours | Number | No | Auto-sum from Visits |
| RemainingAuthorizedHours | Number | No | Auto-calculated |
| UtilizationPercent | Number | No | Auto-calculated |
| Status | Choice | Yes | Active, Warning, Max Reached, Closed |

**Calculated Columns:**
```
RemainingAuthorizedHours:
=AuthorizedHours - TotalUsedHours

UtilizationPercent:
=(TotalUsedHours / AuthorizedHours) * 100
```

---

### 4. VISITS List

**Purpose:** Track all client visits (scheduled and on-call)

**Steps:**
1. Create new list named `Visits`
2. Add columns:

| Column Name | Type | Required | Notes |
|---|---|---|---|
| VisitID | Single line of text | Yes | Format: AUTO-GENERATE |
| ClientID | Lookup | Yes | Links to Clients |
| CaregiverID | Lookup | Yes | Links to Caregivers |
| VisitDate | Date | Yes | |
| StartTime | Time | Yes | |
| EndTime | Time | Yes | |
| Hours | Number | No | Auto-calculated |
| VisitType | Choice | Yes | Scheduled, OnCall |

**Calculated Column:**
```
Hours:
=(EndTime - StartTime)*24
```

---

### 5. CALL OUTS List

**Purpose:** Track caregiver call-outs and replacement tracking

**Steps:**
1. Create new list named `CallOuts`
2. Add columns:

| Column Name | Type | Required | Notes |
|---|---|---|---|
| CallOutID | Single line of text | Yes | Format: AUTO-GENERATE |
| CallOutDate | Date | Yes | |
| CaregiverID | Lookup | Yes | Original caregiver |
| ShiftStart | Time | Yes | |
| ShiftEnd | Time | Yes | |
| Reason | Choice | Yes | Sick, Emergency, Other |
| ClientID | Lookup | Yes | Client affected |
| ReplacementCaregiverID | Lookup | No | Assigned replacement |
| Status | Choice | Yes | Open, Filled, Cancelled |
| CoverageScore | Number | No | Calculated by flow |

---

## Lookup Configuration

### Apply Lookup Relationships:

1. **CaregiverAvailability.CaregiverID** → Caregivers.CaregiverID
2. **Visits.ClientID** → Clients.ClientID
3. **Visits.CaregiverID** → Caregivers.CaregiverID
4. **CallOuts.CaregiverID** → Caregivers.CaregiverID
5. **CallOuts.ClientID** → Clients.ClientID
6. **CallOuts.ReplacementCaregiverID** → Caregivers.CaregiverID

---

## Validation Rules

### Apply to Clients List:

1. **Authorization End Date** must be after **Start Date**
2. **Authorized Hours** must be > 0
3. Prevent scheduling when `RemainingAuthorizedHours <= 0`

### Apply to Visits List:

1. **End Time** must be after **Start Time**
2. **Hours** cannot exceed `Client.RemainingAuthorizedHours`
3. **CaregiverID** must have availability for that date/time

### Apply to CallOuts List:

1. **CallOutDate** cannot be in the past
2. **ShiftEnd** must be after **ShiftStart**
3. Only allows one active call-out per caregiver per date

---

## Next Steps

1. ✅ Create all 5 lists
2. ✅ Configure columns and data types
3. ✅ Set up lookup relationships
4. ⏭️ See `POWER_AUTOMATE_FLOWS.md` for workflow automation
5. ⏭️ See `POWER_BI_DASHBOARDS.md` for reporting

---

## Troubleshooting

**Issue:** Lookup columns not showing data
- **Solution:** Ensure source list is created first, then create lookup

**Issue:** Calculated columns showing errors
- **Solution:** Verify all referenced columns exist and have correct data types

**Issue:** List performance is slow
- **Solution:** Create indexed columns for frequently filtered fields (CaregiverID, ClientID, Status)

