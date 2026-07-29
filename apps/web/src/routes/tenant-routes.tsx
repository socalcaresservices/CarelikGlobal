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
import { IncidentsPage } from "@/pages/incidents-page";
import { SettingsPage } from "@/pages/settings-page";
import { OwnerDashboardPage } from "@/pages/owner-dashboard-page";
import { ApplicantsPage } from "@/pages/applicants-page";
import { ApplicantDetailPage } from "@/pages/applicant-detail-page";

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
    <Route key="credentials" path="/credentials" element={<CredentialsPage />} />,
    <Route key="authorizations" path="/authorizations" element={<AuthorizationsPage />} />,
    <Route key="incidents" path="/incidents" element={<IncidentsPage />} />,
    <Route key="applicants" path="/applicants" element={<ApplicantsPage />} />,
    <Route key="applicant-detail" path="/applicants/:id" element={<ApplicantDetailPage />} />,
    <Route key="access" path="/access" element={<AccessPage />} />,
    <Route key="settings" path="/settings" element={<SettingsPage />} />
    // TODO: Audit logging (tenant-scoped)
  ];
}
