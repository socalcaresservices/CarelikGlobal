/**
 * Tenant Routes ({tenant}.carelik.com)
 *
 * These routes are for agency staff managing a single organization's operations:
 * - Dashboard
 * - Clients
 * - Caregivers/Team
 * - Applicants
 * - Schedules
 * - Credentials & Authorizations
 * - Documents & Incidents
 * - Organization Settings (tenant-specific)
 *
 * Tenant users should NEVER see:
 * - Organization registry
 * - Platform subscriptions/billing
 * - System administration
 * - Feature flags
 * - Organization switcher
 */

import { Route } from "react-router-dom";
import { CommandCenterPage } from "@/pages/command-center-page";
import { AccessPage } from "@/pages/access-page";
import { TeamPage } from "@/pages/team-page";
import { CaregiverDetailPage } from "@/pages/caregiver-detail-page";
import { ClientsPage } from "@/pages/clients-page";
import { ClientDetailPage } from "@/pages/client-detail-page";
import { SchedulePage } from "@/pages/schedule-page";
import { CredentialsPage } from "@/pages/credentials-page";
import { AuthorizationsPage } from "@/pages/authorizations-page";
import { BillingPage } from "@/pages/billing-page";
import { IncidentsPage } from "@/pages/incidents-page";
import { SettingsPage } from "@/pages/settings-page";
import { OwnerDashboardPage } from "@/pages/owner-dashboard-page";
import { ApplicantsPage } from "@/pages/applicants-page";
import { ApplicantDetailPage } from "@/pages/applicant-detail-page";
import { ServiceVerificationPage } from "@/pages/service-verification-page";
import { ServiceVerificationReportsPage } from "@/pages/service-verification-reports-page";
import { StaffVisitsPage } from "@/pages/staff-visits-page";
import { AuditPage } from "@/pages/audit-page";

/**
 * Tenant route definitions
 * Wrapped in a function so they can be conditionally rendered in App.tsx
 */
export function getTenantRoutes() {
  return [
    <Route key="dashboard" path="/" element={<CommandCenterPage />} />,
    <Route key="owner-dashboard" path="/owner-dashboard" element={<OwnerDashboardPage />} />,
    <Route key="team" path="/team" element={<TeamPage />} />,
    <Route key="team-detail" path="/team/:id" element={<CaregiverDetailPage />} />,
    <Route key="clients" path="/clients" element={<ClientsPage />} />,
    <Route key="client-detail" path="/clients/:id" element={<ClientDetailPage />} />,
    <Route key="schedule" path="/schedule" element={<SchedulePage />} />,
    <Route key="staff-visits" path="/staff/visits" element={<StaffVisitsPage />} />,
    <Route key="service-verification" path="/service-verification" element={<ServiceVerificationPage />} />,
    <Route
      key="service-verification-reports"
      path="/service-verification/reports"
      element={<ServiceVerificationReportsPage />}
    />,
    // Same page, alias path - "signed sheets" is the workspace name used
    // in the Service Routing spec; /reports is the original, still-linked
    // path from the nav and existing bookmarks, kept working rather than
    // moved.
    <Route
      key="service-verification-signed-sheets"
      path="/service-verification/signed-sheets"
      element={<ServiceVerificationReportsPage />}
    />,
    <Route key="credentials" path="/credentials" element={<CredentialsPage />} />,
    <Route key="authorizations" path="/authorizations" element={<AuthorizationsPage />} />,
    <Route key="billing" path="/billing" element={<BillingPage />} />,
    <Route key="incidents" path="/incidents" element={<IncidentsPage />} />,
    <Route key="applicants" path="/applicants" element={<ApplicantsPage />} />,
    <Route key="applicant-detail" path="/applicants/:id" element={<ApplicantDetailPage />} />,
    <Route key="access" path="/access" element={<AccessPage />} />,
    <Route key="audit" path="/audit" element={<AuditPage />} />,
    <Route key="settings" path="/settings" element={<SettingsPage />} />
  ];
}
