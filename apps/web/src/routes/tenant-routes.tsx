/**
 * Tenant Routes
 * Organization-scoped operational screens only.
 */

import { Route } from "react-router-dom";
import { CommandCenterPage } from "@/pages/command-center-page";
import { AccessPage } from "@/pages/access-page";
import { TeamPage } from "@/pages/team-page";
import { CaregiverDetailPage } from "@/pages/caregiver-detail-page";
import { WorkforcePage } from "@/pages/workforce-page";
import { WorkforceDetailPage } from "@/pages/workforce-detail-page";
import { ClientsPage } from "@/pages/clients-page";
import { ClientDetailPage } from "@/pages/client-detail-page";
import { SchedulePage } from "@/pages/schedule-page";
import { CredentialsPage } from "@/pages/credentials-page";
import { AuthorizationsPage } from "@/pages/authorizations-page";
import { IncidentsPage } from "@/pages/incidents-page";
import { SettingsPage } from "@/pages/settings-page";
import { OwnerDashboardPage } from "@/pages/owner-dashboard-page";
import { ApplicantsPage } from "@/pages/applicants-page";
import { CandidateDetailPage } from "@/pages/candidate-detail-page";
import { ServiceVerificationPage } from "@/pages/service-verification-page";
import { ServiceVerificationReportsPage } from "@/pages/service-verification-reports-page";
import { StaffVisitsPage } from "@/pages/staff-visits-page";

export function getTenantRoutes() {
  return [
    <Route key="dashboard" path="/" element={<CommandCenterPage />} />,
    <Route key="owner-dashboard" path="/owner-dashboard" element={<OwnerDashboardPage />} />,
    <Route key="team" path="/team" element={<TeamPage />} />,
    <Route key="team-detail" path="/team/:id" element={<CaregiverDetailPage />} />,
    <Route key="workforce" path="/workforce" element={<WorkforcePage />} />,
    <Route key="workforce-detail" path="/workforce/:id" element={<WorkforceDetailPage />} />,
    <Route key="clients" path="/clients" element={<ClientsPage />} />,
    <Route key="client-detail" path="/clients/:id" element={<ClientDetailPage />} />,
    <Route key="schedule" path="/schedule" element={<SchedulePage />} />,
    <Route key="staff-visits" path="/staff/visits" element={<StaffVisitsPage />} />,
    <Route key="service-verification" path="/service-verification" element={<ServiceVerificationPage />} />,
    <Route key="service-verification-reports" path="/service-verification/reports" element={<ServiceVerificationReportsPage />} />,
    <Route key="service-verification-signed-sheets" path="/service-verification/signed-sheets" element={<ServiceVerificationReportsPage />} />,
    <Route key="credentials" path="/credentials" element={<CredentialsPage />} />,
    <Route key="authorizations" path="/authorizations" element={<AuthorizationsPage />} />,
    <Route key="incidents" path="/incidents" element={<IncidentsPage />} />,
    <Route key="applicants" path="/applicants" element={<ApplicantsPage />} />,
    <Route key="candidate-detail" path="/applicants/:id" element={<CandidateDetailPage />} />,
    <Route key="access" path="/access" element={<AccessPage />} />,
    <Route key="settings" path="/settings" element={<SettingsPage />} />
  ];
}
