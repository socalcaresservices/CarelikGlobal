# Home Care Scheduling System - Implementation Checklist

## Phase 1: SharePoint Lists Setup (Week 1)

### List Creation
- [ ] Create **Caregivers** list with all required columns
- [ ] Create **CaregiverAvailability** list
- [ ] Create **Clients** list
- [ ] Create **Visits** list
- [ ] Create **CallOuts** list

### Configure Columns
- [ ] Verify all column types are correct (Date, Time, Number, Choice, Lookup, etc.)
- [ ] Set "Required" flags on mandatory fields
- [ ] Add default values where applicable
- [ ] Create calculated columns:
  - [ ] Caregivers.RemainingHours = MaxWeeklyHours - CurrentScheduledHours
  - [ ] CaregiverAvailability.AvailableHours = (EndTime - StartTime) * 24
  - [ ] Clients.RemainingAuthorizedHours = AuthorizedHours - TotalUsedHours
  - [ ] Clients.UtilizationPercent = (TotalUsedHours / AuthorizedHours) * 100
  - [ ] Visits.Hours = (EndTime - StartTime) * 24

### Setup Lookup Relationships
- [ ] CaregiverAvailability.CaregiverID → Caregivers
- [ ] Visits.ClientID → Clients
- [ ] Visits.CaregiverID → Caregivers
- [ ] CallOuts.CaregiverID → Caregivers
- [ ] CallOuts.ClientID → Clients
- [ ] CallOuts.ReplacementCaregiverID → Caregivers

### Add Validation Rules
- [ ] Clients: End Date > Start Date
- [ ] Clients: Authorized Hours > 0
- [ ] Visits: End Time > Start Time
- [ ] CallOuts: Call-out Date not in past
- [ ] CallOuts: Shift End > Shift Start

### Testing
- [ ] Test creating a caregiver record
- [ ] Test creating a client record
- [ ] Test creating a visit record
- [ ] Verify calculated columns populate correctly
- [ ] Verify lookup relationships work

---

## Phase 2: Power Automate Flows Setup (Week 1-2)

### Flow 1: Authorization Alert Notifications
- [ ] Create flow trigger: "When an item is modified" in Clients list
- [ ] Add condition: UtilizationPercent >= 75
- [ ] Add three branches for alert levels (Yellow/Orange/Red)
- [ ] Configure email action to send to scheduler
- [ ] Add update action to set Client Status field
- [ ] Test with test client at different utilization levels:
  - [ ] Test at 75% (Yellow alert)
  - [ ] Test at 90% (Orange alert)
  - [ ] Test at 100% (Red alert)

### Flow 2: Caregiver Call-Out Workflow
- [ ] Create flow trigger: "When an item is created" in CallOuts list
- [ ] Add actions to query available caregivers (Active, not over hours)
- [ ] Add filter for matching Service Area
- [ ] Add filter for availability during shift time
- [ ] Add calculations for Coverage Score components
- [ ] Create ranking by Coverage Score
- [ ] Configure email to send top 10 candidates with scores
- [ ] Test with test call-out:
  - [ ] Verify correct caregivers are identified
  - [ ] Verify Coverage Scores are calculated
  - [ ] Verify email is sent with recommendations

### Flow 3: Open Shift Alert
- [ ] Create flow trigger: "When an item is modified" in Visits list
- [ ] Add condition: CaregiverID becomes empty
- [ ] Query available caregivers for Service Area
- [ ] Filter for time availability
- [ ] Calculate Coverage Scores
- [ ] Send email with recommendations
- [ ] Test by removing caregiver from a visit

### Flow 4: Shift Conflict Prevention
- [ ] Create flow trigger: "When an item is created or modified" in Visits
- [ ] Add validation check: Caregiver double-booking
- [ ] Add validation check: Client authorization remaining
- [ ] Add validation check: Caregiver weekly hour limit
- [ ] Add validation check: Caregiver availability
- [ ] Add validation check: Certification requirements
- [ ] Test creating conflicting visits:
  - [ ] Try to assign caregiver to overlapping times (should fail)
  - [ ] Try to exceed client authorization (should fail)
  - [ ] Try to exceed caregiver max hours (should fail/warn)
  - [ ] Assign caregiver without required certifications (should fail)

### Flow 5: Weekly Utilization Report
- [ ] Create scheduled flow for daily at 6 AM
- [ ] Add actions to calculate caregiver metrics
- [ ] Add actions to calculate client metrics
- [ ] Add risk flagging for overtime/high utilization
- [ ] Configure email to management with attached Excel
- [ ] Test by running manually first

---

## Phase 3: Power BI Setup (Week 2)

### Data Connection
- [ ] Open Power BI Desktop
- [ ] Connect to SharePoint Online
- [ ] Load all 5 lists
- [ ] Verify data types in Power Query Editor
- [ ] Create proper date/time formats

### Data Model
- [ ] Create relationships between tables:
  - [ ] Visits ↔ Caregivers (One-to-Many)
  - [ ] Visits ↔ Clients (One-to-Many)
  - [ ] CallOuts ↔ Caregivers (One-to-Many)
  - [ ] CallOuts ↔ Clients (One-to-Many)
  - [ ] CaregiverAvailability ↔ Caregivers (One-to-Many)

### Create Measures
- [ ] Total Authorized Hours
- [ ] Total Used Hours
- [ ] Total Remaining Hours
- [ ] Overall Utilization %
- [ ] Count of Active Caregivers
- [ ] Count of Active Clients
- [ ] Average Hours per Caregiver
- [ ] Coverage Success Rate

### Dashboard 1: Executive Overview
- [ ] Add KPI cards:
  - [ ] Total Authorized Hours
  - [ ] Used Hours This Month
  - [ ] Remaining Hours
  - [ ] Utilization Rate
- [ ] Add summary cards:
  - [ ] Active Caregivers (with breakdown: FT/PT/PRN)
  - [ ] Active Clients (with breakdown by status)
- [ ] Add today's operations box
- [ ] Format with company branding

### Dashboard 2: Client Authorization Tracking
- [ ] Create summary table with:
  - [ ] Client Name, Auth Hours, Used Hours, Remaining %, Status
  - [ ] Conditional formatting (Red/Yellow/Green by status)
- [ ] Add stacked bar chart: Utilization by Status
- [ ] Add line chart: Authorization Expiration Timeline
- [ ] Add filters by Status, Service Area, Date Range

### Dashboard 3: Caregiver Utilization
- [ ] Create table with caregiver details:
  - [ ] Name, Status (FT/PT/PRN), Scheduled, Remaining, Overtime Risk
- [ ] Add pie chart: Average Hours by Employment Status
- [ ] Add histogram/box plot: Hours Distribution
- [ ] Add overtime risk summary box
- [ ] Add filters by Status, Service Area, Hire Date

### Dashboard 4: Call-Out & Coverage Trends
- [ ] Add pie chart: Call-Outs by Reason (Last 30 Days)
- [ ] Add gauge chart: Coverage Success Rate
- [ ] Add line chart: Call-Outs Over Time (Trend)
- [ ] Add table: High-Risk Caregivers (frequent call-outs)
- [ ] Add filters by Date Range, Reason

### Dashboard 5: Open Shifts & Scheduling
- [ ] Create summary of open shifts
- [ ] Add table: Open Shifts by Client & Date
- [ ] Add filters by Date Range, Service Area, Client

### Dashboard 6: Service Area Capacity
- [ ] Add bar chart: Caregivers per Service Area
- [ ] Add area chart: Client Demand by Service Area
- [ ] Add staffing adequacy scorecard
- [ ] Add filters by Service Area

### Dashboard 7: Coverage Score Rankings
- [ ] Create table: Top 20 Caregivers by Coverage Score
- [ ] Include: Rank, Name, Score, Clients Count, Certifications
- [ ] Add sorting by Coverage Score (Descending)

### Dashboard 8: Authorization Expiration Monitor
- [ ] Add summary: Expiring Soon (30 days), Expired, etc.
- [ ] Add Gantt chart or calendar: Expiration Timeline
- [ ] Add renewal deadline flags

### Publishing
- [ ] Publish Power BI report to Power BI Service
- [ ] Share with stakeholder group
- [ ] Create SharePoint page for embedding
- [ ] Add Power BI Web Part to SharePoint
- [ ] Configure auto-refresh schedule (Daily at 2 AM)

---

## Phase 4: User Training & Go-Live (Week 3)

### Documentation
- [ ] Create user guide for schedulers
- [ ] Create quick reference: Coverage Score calculation
- [ ] Create troubleshooting guide
- [ ] Document alert thresholds (75%, 90%, 100%)
- [ ] Document call-out procedures

### Staff Training
- [ ] Schedule training session for schedulers
- [ ] Demonstrate Power Automate notifications
- [ ] Walk through call-out workflow
- [ ] Show how to use Power BI dashboards
- [ ] Test with real data

### Production Data Migration
- [ ] Export existing caregiver data
- [ ] Create initial caregiver records in SharePoint
- [ ] Export existing client data
- [ ] Create initial client records in SharePoint
- [ ] Review data for accuracy
- [ ] Archive old system data

### Go-Live
- [ ] Switch off old scheduling system
- [ ] Turn on all Power Automate flows
- [ ] Enable Power BI dashboard access
- [ ] Monitor for issues first 24 hours
- [ ] Provide on-call support

---

## Phase 5: Optimization & Monitoring (Week 4+)

### Performance Monitoring
- [ ] Monitor Power Automate flow run times
- [ ] Check for flow failures and errors
- [ ] Monitor Power BI refresh times
- [ ] Review user adoption rates

### Data Quality Checks
- [ ] Verify calculated fields are accurate
- [ ] Review for data entry errors
- [ ] Check for duplicate caregiver/client records
- [ ] Validate historical data migration

### Optimizations
- [ ] Archive old visits (6+ months) to improve performance
- [ ] Create indexed columns for frequent filters
- [ ] Optimize Power BI queries if needed
- [ ] Add additional dashboards based on user feedback

### Continuous Improvement
- [ ] Gather user feedback on workflows
- [ ] Monitor call-out trends and patterns
- [ ] Track coverage success rates
- [ ] Identify training needs
- [ ] Plan enhancements for next phase

---

## Quick Troubleshooting Guide

### Problem: "Calculated column shows error"
**Solution:** 
- Check all referenced columns exist
- Verify data types match expected inputs
- For time calculations: Use formula `=(EndTime-StartTime)*24`

### Problem: "Lookup column not showing data"
**Solution:**
- Verify source list is created first
- Ensure lookup column is configured correctly
- Check that matching IDs exist in source list

### Problem: "Power Automate flow not triggering"
**Solution:**
- Verify trigger condition is correct
- Check that list actually modified (not just viewed)
- Review flow run history for errors
- Try manual trigger first to test flow logic

### Problem: "Email not sending from flow"
**Solution:**
- Verify email recipient is valid
- Check Power Automate has email permissions
- Test with your own email first
- Check spam folder

### Problem: "Power BI shows old data"
**Solution:**
- Click "Refresh" in Power BI Desktop
- In Power BI Service: Check last refresh time
- Verify scheduled refresh is enabled
- Check data source connection

---

## Contact & Support

**SharePoint Admin:** [Your Name/Department]
**Power Automate Owner:** [Your Name/Department]
**Power BI Manager:** [Your Name/Department]
**Training Contact:** [Your Name/Department]

**Escalation Procedure:**
1. Contact your direct supervisor
2. Reach out to system owner
3. File IT ticket if technical issue
4. Schedule training if procedural issue

---

## Success Metrics

Track these metrics after go-live:

- **Call-Out Resolution Time:** Target < 2 hours
- **Coverage Success Rate:** Target > 90%
- **Authorization Violations:** Target 0
- **Double-Booking Incidents:** Target 0
- **Caregiver Overtime Compliance:** Target > 95%
- **System Uptime:** Target 99.5%
- **User Adoption Rate:** Target 95% within 2 weeks

