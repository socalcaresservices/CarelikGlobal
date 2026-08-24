/**
 * Tenant Routes
 * Organization-scoped operational screens only.
 */

import { Navigate, Route } from "react-router-dom";
import { CommandCenterPage } from "@/pages/command-center-page";
import { AccessPage } from "@/pages/access-page";
import { CareTeamPage } from "@/pages/care-team-page";
import { CareTeamDetailPage } from "@/pages/care-team-detail-page";
import { ClientsPage } from "@/pages/clients-page";
import { ClientDetailPage } from "@/pages/client-detail-page";
import { SchedulePage } from "@/pages/schedule-page";
import { CredentialsPage } from "@/pages/credentials-page";
import { AuthorizationsPage } from "@/pages/authorizations-page";
import { IncidentsPage } from "@/pages/incidents-page";
import { SettingsPage } from "@/pages/settings-page";
import { CandidatesPage } from "@/pages/candidates-page";
import { CandidateDetailPage } from "@/pages/candidate-detail-page";
import { ServiceVerificationPage } from "@/pages/service-verification-page";
import { ServiceVerificationReportsPage } from "@/pages/service-verification-reports-page";
import { StaffVisitsPage } from "@/pages/staff-visits-page";
import { BillingPage } from "@/pages/billing-page";
import { SupportRequestsPage } from "@/pages/support-requests-page";

export function getTenantRoutes() {
  return [
    <Route key="dashboard" path="/" element={<CommandCenterPage />} />,
    // Owner Dashboard's content moved into Command Center
    // (components/owner-insights.tsx) so an owner isn't navigating
    // between two dashboard pages for one full picture - redirect
    // rather than a dead link for anyone with this route bookmarked.
    <Route key="owner-dashboard" path="/owner-dashboard" element={<Navigate to="/" replace />} />,
    <Route key="team" path="/team" element={<CareTeamPage />} />,
    <Route key="team-detail" path="/team/:id" element={<CareTeamDetailPage />} />,
    <Route key="workforce" path="/workforce" element={<Navigate to="/team" replace />} />,
    <Route key="workforce-detail" path="/workforce/:id" element={<CareTeamDetailPage />} />,
    <Route key="clients" path="/clients" element={<ClientsPage />} />,
    <Route key="client-detail" path="/clients/:id" element={<ClientDetailPage />} />,
    <Route key="schedule" path="/schedule" element={<SchedulePage />} />,
    <Route key="staff-visits" path="/staff/visits" element={<StaffVisitsPage />} />,
    <Route key="service-verification" path="/service-verification" element={<ServiceVerificationPage />} />,
    <Route key="service-verification-reports" path="/service-verification/reports" element={<ServiceVerificationReportsPage />} />,
    <Route key="service-verification-signed-sheets" path="/service-verification/signed-sheets" element={<ServiceVerificationReportsPage />} />,
    <Route key="billing" path="/billing" element={<BillingPage />} />,
    <Route key="credentials" path="/credentials" element={<CredentialsPage />} />,
    <Route key="authorizations" path="/authorizations" element={<AuthorizationsPage />} />,
    <Route key="incidents" path="/incidents" element={<IncidentsPage />} />,
    <Route key="candidates" path="/candidates" element={<CandidatesPage />} />,
    <Route key="candidate-detail" path="/candidates/:id" element={<CandidateDetailPage />} />,
    <Route key="applicants" path="/applicants" element={<Navigate to="/candidates" replace />} />,
    <Route key="applicant-detail" path="/applicants/:id" element={<CandidateDetailPage />} />,
    <Route key="access" path="/access" element={<AccessPage />} />,
    <Route key="support" path="/support" element={<SupportRequestsPage />} />,
    <Route key="settings" path="/settings" element={<SettingsPage />} />
  ];
}
