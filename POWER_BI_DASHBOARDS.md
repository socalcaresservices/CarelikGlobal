# Power BI Dashboards - Setup Guide

## Overview
Power BI connects to SharePoint lists to provide real-time analytics and visualization of scheduling and utilization data.

---

## Data Source Configuration

### Step 1: Connect SharePoint to Power BI

1. Open **Power BI Desktop**
2. Click **Get Data** > **SharePoint Online List**
3. Enter your SharePoint site URL
4. Select all 5 lists:
   - Caregivers
   - CaregiverAvailability
   - Clients
   - Visits
   - CallOuts
5. Load data into Power BI

### Step 2: Create Data Model Relationships

Create relationships:
```
Visits.CaregiverID → Caregivers.CaregiverID (One-to-Many)
Visits.ClientID → Clients.ClientID (One-to-Many)
CallOuts.CaregiverID → Caregivers.CaregiverID (One-to-Many)
CallOuts.ClientID → Clients.ClientID (One-to-Many)
CallOuts.ReplacementCaregiverID → Caregivers.CaregiverID (One-to-Many)
CaregiverAvailability.CaregiverID → Caregivers.CaregiverID (One-to-Many)
```

### Step 3: Create Calculated Columns and Measures

---

## Dashboard 1: Executive Overview

**Purpose:** High-level KPIs and operational status

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Home Care Scheduling - Executive Dashboard                  │
└─────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Total Hours │  Used Hours  │ Remaining    │ Utilization  │
│  Authorized  │  This Month  │ Hours        │ Rate         │
│              │              │              │              │
│   45,280     │   38,100     │   7,180      │    84.1%     │
└──────────────┴──────────────┴──────────────┴──────────────┘

┌──────────────────────────────┬──────────────────────────────┐
│  Active Caregivers           │  Active Clients              │
│                              │                              │
│        87                    │       62                     │
│  Full-Time: 34               │  Active: 58                  │
│  Part-Time: 28               │  Warning: 4                  │
│  PRN: 25                     │  Max Reached: 0              │
└──────────────────────────────┴──────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Today's Operations                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Scheduled Visits: 42      Open Shifts: 3                   │
│  Call Outs: 2              Filled: 1       Pending: 1       │
│  Overtime at Risk: 5 caregivers                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key Measures:**
- Total Authorized Hours: `SUM(Clients[AuthorizedHours])`
- Total Used Hours: `SUM(Clients[TotalUsedHours])`
- Overall Utilization: `DIVIDE(SUM(Clients[TotalUsedHours]), SUM(Clients[AuthorizedHours]))`
- Count of Active Caregivers: `COUNTIF(Caregivers[Active], TRUE)`
- Count of Active Clients: `COUNTIF(Clients[Status], "Active")`

---

## Dashboard 2: Client Authorization Tracking

**Purpose:** Monitor client hours and prevent over-authorization

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Client Authorization & Utilization                         │
└─────────────────────────────────────────────────────────────┘

[Filter by Status, Service Area, Date Range]

┌─────────────────────────────────────────────────────────────┐
│  Client Authorization Summary (Table)                       │
├──────────────┬──────────┬──────────┬──────────┬──────────────┤
│ Client Name  │ Auth Hrs │ Used Hrs │ Remain % │ Status       │
├──────────────┼──────────┼──────────┼──────────┼──────────────┤
│ John Smith   │ 160      │ 144      │ 10%      │ WARNING ⚠️   │
│ Jane Doe     │ 120      │ 120      │ 0%       │ MAX REACHED  │
│ Bob Johnson  │ 240      │ 180      │ 25%      │ ACTIVE       │
│ ...          │ ...      │ ...      │ ...      │ ...          │
└──────────────┴──────────┴──────────┴──────────┴──────────────┘

┌────────────────────────────┬────────────────────────────┐
│  Utilization by Status     │  Expiration Timeline       │
│                            │                            │
│  [Stacked Bar Chart]       │  [Line Chart]              │
│  Active: 58 clients        │  Shows expirations by     │
│  Warning: 4 clients        │  month for next 12 months │
│  Max Reached: 0 clients    │                            │
│  Closed: 3 clients         │                            │
└────────────────────────────┴────────────────────────────┘
```

**Key Measures:**
```
Authorized Hours: SUM(Clients[AuthorizedHours])
Used Hours: SUM(Clients[TotalUsedHours])
Remaining Hours: SUM(Clients[RemainingAuthorizedHours])
Utilization %: [Total Used Hours] / [Total Authorized Hours]
Clients at Risk (75%+): COUNTIFS(Clients[UtilizationPercent], ">=75")
```

**Alerts:**
- Highlight rows where UtilizationPercent > 90% (RED)
- Highlight rows where UtilizationPercent between 75-90% (YELLOW)

---

## Dashboard 3: Caregiver Utilization

**Purpose:** Monitor caregiver workload and capacity

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Caregiver Utilization & Capacity                           │
└─────────────────────────────────────────────────────────────┘

[Filter by Status (FT/PT/PRN), Service Area, Hire Date Range]

┌────────────────────────────┬────────────────────────────┐
│  Average Weekly Hours      │  Hours Worked Distribution │
│  by Employment Status      │                            │
│                            │                            │
│  [Pie/Donut Chart]         │  [Histogram/Box Plot]      │
│  FT: 38.5 hrs              │  Shows spread of hours     │
│  PT: 24.3 hrs              │  across all caregivers     │
│  PRN: 12.1 hrs             │                            │
└────────────────────────────┴────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Caregiver Detail Table                                     │
├──────────────┬──────────┬──────────┬──────────┬──────────────┤
│ Caregiver    │ Status   │ Scheduled│ Remaining│ Overtime Risk│
├──────────────┼──────────┼──────────┼──────────┼──────────────┤
│ Sarah Lee    │ FT       │ 42       │ (2)      │ ⚠️ RISK      │
│ Mike Brown   │ PT       │ 28       │ 12       │ OK           │
│ Lisa Jones   │ FT       │ 38       │ 2        │ ⚠️ RISK      │
│ ...          │ ...      │ ...      │ ...      │ ...          │
└──────────────┴──────────┴──────────┴──────────┴──────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Overtime Risk Summary                                      │
├─────────────────────────────────────────────────────────────┤
│ Caregivers at or exceeding max hours: 7                    │
│ Action needed: Contact managers for workload balancing     │
└─────────────────────────────────────────────────────────────┘
```

**Key Measures:**
```
Average Hours: AVERAGE(Visits[Hours])
Scheduled Hours: SUM(Visits[Hours])
Capacity Utilization: [Scheduled Hours] / [Max Weekly Hours]
Overtime Count: COUNTIF(Caregivers[CurrentScheduledHours], ">MaxWeeklyHours")
```

---

## Dashboard 4: Call-Out & Coverage Trends

**Purpose:** Analyze call-out patterns and coverage success

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Call-Out & Coverage Analysis                              │
└─────────────────────────────────────────────────────────────┘

[Filter by Date Range, Reason, Status]

┌────────────────────────────┬────────────────────────────┐
│  Call-Outs by Reason       │  Coverage Success Rate     │
│  (Last 30 Days)            │                            │
│                            │  Filled: 87%               │
│  [Pie Chart]               │  Pending: 10%              │
│  Sick: 24 (68%)            │  Cancelled: 3%             │
│  Emergency: 8 (23%)        │                            │
│  Other: 3 (9%)             │  [Gauge Chart]             │
└────────────────────────────┴────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Call-Outs Over Time (Trend)                                │
│                                                              │
│  [Line Chart - Last 12 weeks]                               │
│  Shows weekly call-out volume                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  High-Risk Caregivers                                       │
├──────────────┬──────────────────┬──────────────────────────┤
│ Caregiver    │ Call-Outs/Month  │ Status                   │
├──────────────┼──────────────────┼──────────────────────────┤
│ Robert Davis │ 4                │ Review Performance ⚠️    │
│ Amy Wilson   │ 3                │ Monitor                  │
│ Tom Harris   │ 3                │ Monitor                  │
└──────────────┴──────────────────┴──────────────────────────┘
```

**Key Measures:**
```
Total Call-Outs: COUNTIF(CallOuts[Status], "*")
Filled Call-Outs: COUNTIF(CallOuts[Status], "Filled")
Coverage Success Rate: [Filled Call-Outs] / [Total Call-Outs]
Avg Time to Fill: AVERAGE(CallOuts[TimeToFill])
```

---

## Dashboard 5: Open Shifts & Scheduling

**Purpose:** Track open shifts and coverage gaps

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Open Shifts & Scheduling Status                            │
└─────────────────────────────────────────────────────────────┘

[Filter by Date Range, Service Area, Client]

┌──────────────────────────────────────────────────────────┐
│  Open Shifts Summary                                      │
├──────────────────────────────────────────────────────────┤
│  Total Open Shifts (This Month): 12                       │
│  Average Days Open: 2.3 days                              │
│  Longest Open: John Smith - 7 days ⚠️                    │
└──────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Open Shifts by Client & Date                               │
├──────────────┬──────────┬──────────┬──────────┬──────────────┤
│ Client       │ Date     │ Time     │ Days Open│ Recommended  │
├──────────────┼──────────┼──────────┼──────────┼──────────────┤
│ Jane Doe     │ 08-30    │ 8am-2pm  │ 7       │ Sarah Lee    │
│ Bob Johnson  │ 08-31    │ 2pm-8pm  │ 3       │ Mike Brown   │
│ ...          │ ...      │ ...      │ ...      │ ...          │
└──────────────┴──────────┴──────────┴──────────┴──────────────┘
```

---

## Dashboard 6: Service Area Capacity

**Purpose:** Monitor staffing levels by service area

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Service Area Staffing & Capacity                           │
└─────────────────────────────────────────────────────────────┘

[Filter by Service Area, Month]

┌────────────────────────────┬────────────────────────────┐
│  Caregivers per Service    │  Client Demand by Area     │
│                            │                            │
│  [Bar Chart]               │  [Area Chart]              │
│  Home Health: 34           │  Shows authorized hours   │
│  Elderly Care: 28          │  per service area         │
│  Personal Care: 25         │                            │
└────────────────────────────┴────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Staffing Adequacy Score (by Area)                           │
│                                                              │
│  Home Health:     92% (Adequate)                             │
│  Elderly Care:    76% (Needs Staff) ⚠️                      │
│  Personal Care:   88% (Adequate)                             │
└──────────────────────────────────────────────────────────────┘
```

---

## Dashboard 7: Coverage Score Rankings

**Purpose:** Rank caregivers by coverage capability

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Caregiver Coverage Score Rankings                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Top 20 Coverage Score Leaders                              │
├────┬──────────────┬──────────────┬────────┬────────────────┤
│Rank│ Caregiver    │ Coverage Scr │ Clients│ Certifications │
├────┼──────────────┼──────────────┼────────┼────────────────┤
│ 1  │ Sarah Lee    │ 98           │ 8      │ CNA, RN        │
│ 2  │ Mike Brown   │ 94           │ 6      │ CNA            │
│ 3  │ Lisa Jones   │ 92           │ 9      │ CNA, LPN       │
│ .. │ ...          │ ...          │ ...    │ ...            │
└────┴──────────────┴──────────────┴────────┴────────────────┘
```

---

## Dashboard 8: Authorization Expiration Monitor

**Purpose:** Track upcoming authorization expirations

**Page Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Authorization Renewal Timeline                             │
└─────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  Expiring Soon (Next 30 Days): 8 clients                   │
├────────────────────────────────────────────────────────────┤
│  Expired (Past Due): 1 client ⚠️                            │
└────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Expiration Calendar (Next 90 Days)                         │
│                                                              │
│  [Gantt Chart or Calendar View]                             │
│  Each client bar shows:                                     │
│  - Current utilization %                                    │
│  - Days remaining until expiration                          │
│  - Renewal deadline flag                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Publishing to SharePoint

1. **Publish to Power BI Service**
   - In Power BI Desktop: File > Publish
   - Select workspace
   - Share with stakeholders

2. **Embed in SharePoint**
   - Go to Power BI report
   - Click "Share" > "Get Link"
   - Create SharePoint page
   - Add Power BI Web Part
   - Paste report URL

3. **Refresh Schedule**
   - Daily at 2 AM (after overnight operations)
   - Manual refresh available on demand
   - Incremental refresh for large datasets

---

## Performance Optimization Tips

- Use filters to reduce data load
- Aggregate data at monthly/weekly level for trending
- Archive old Call-Outs and Visits (6+ months)
- Use DirectQuery for large datasets
- Create drill-through capabilities

