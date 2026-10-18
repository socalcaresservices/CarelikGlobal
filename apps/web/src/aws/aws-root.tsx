// AWS build root (VITE_AUTH_PROVIDER=cognito): Cognito managed login (code +
// PKCE) -> Ogevia AWS API. Nothing in this tree creates a Supabase client.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CognitoAuthProvider } from "@carelik/auth";
import { useMemo, type PropsWithChildren } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { AwsApiClient } from "@/lib/aws-api";
import type { AwsRuntime } from "./aws-runtime";
import { ServiceVerificationBackendContext } from "@/lib/sv-backend";
import { createAwsServiceVerificationBackend } from "@/lib/sv-backend-aws";
import { AuthorizationImpactsPage } from "./amendment-impacts";
import { ServiceVerificationPage } from "@/pages/service-verification-page";
import { ServiceVerificationReportsPage } from "@/pages/service-verification-reports-page";
import { useOrganization } from "@/providers/organization-provider";
import { AuthCallbackPage, AwsLoginPage, AwsProtectedRoute } from "./aws-auth-pages";
import { AwsOrganizationProvider } from "./aws-organization-provider";
import { AwsLanding, AwsShell } from "./aws-shell";
import { BillingReviewPage } from "./billing-review-page";
import { VisitReviewPage } from "./visit-review-page";
import { BillingRoundingSettingsPage } from "./billing-rounding";
import { VisitRulesPage } from "./visit-rules-page";
import { AccountsPage } from "./accounts-page";
import { CareRequestsPage } from "./care-requests-page";
import { CaregiverAvailabilityPage } from "./caregiver-availability-page";
import { AwsHomePage } from "./home-page";
import { DocumentsPage } from "./documents-page";
import { ClientDetailPage } from "./client-detail-page";
import { ClientsPage } from "./clients-page";
import { CareTeamPage, CaregiverDetailPage } from "./care-team-page";
import { RecruitingPage } from "./recruiting";
import { ComplianceHoldsPage } from "./compliance/holds-page";
import { ServicesReviewPage } from "./readiness/service-approvals";
import { ContinuityPage } from "./continuity-page";
import { OutageVisitsPage } from "./outage-visits-page";
import { MyShiftsPage, SchedulePage } from "./schedule-page";
import { ServicesPage } from "./services-page";
import { BrandingSettingsPage, ProfilePage } from "./workspace-settings-pages";
import { PublicCareOfferPage, PublicCareRequestPage } from "./care-public-pages";
import { ConfirmVisitPage } from "./confirm-visit-page";
import { EnvironmentProvider } from "./environment-marker";
import { ActionNeededPage } from "./action-needed-page";
import { ReportingPage } from "./reporting-page";
import { NeedsAttentionPage, UpcomingStaffingPage, VisitQueuePage } from "./attention-pages";
import { RatesReviewPage } from "./rates-review-page";
import { AppearancePage } from "./appearance/appearance-page";

function AwsBackendProvider({ api, children }: PropsWithChildren<{ api: AwsApiClient }>) {
  const { organizations } = useOrganization();
  const backend = useMemo(
    () => createAwsServiceVerificationBackend(api, (id) => organizations.find((o) => o.id === id)?.displayName ?? null),
    [api, organizations],
  );
  return <ServiceVerificationBackendContext.Provider value={backend}>{children}</ServiceVerificationBackendContext.Provider>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

export function AwsRoutes({ api, publicApi }: { api: AwsApiClient; publicApi: AwsApiClient }) {
  return (
    <Routes>
      <Route path="/login" element={<AwsLoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      {/* Token links: the token is in the URL fragment (#...), never the path. */}
      <Route path="/care" element={<PublicCareRequestPage api={publicApi} />} />
      <Route path="/care-offer" element={<PublicCareOfferPage api={publicApi} />} />
      <Route path="/confirm-visit" element={<ConfirmVisitPage api={publicApi} />} />
      <Route
        path="*"
        element={
          <AwsProtectedRoute>
            <AwsOrganizationProvider api={api}>
              <AwsBackendProvider api={api}>
                <AwsShell>
                  <Routes>
                    <Route path="/" element={<AwsLanding home={<AwsHomePage />} />} />
                    <Route path="/service-verification" element={<ServiceVerificationPage />} />
                    <Route path="/service-verification/reports" element={<ServiceVerificationReportsPage />} />
                    <Route path="/billing-review" element={<BillingReviewPage />} />
                    <Route path="/visits/:visitId" element={<VisitReviewPage />} />
                    <Route path="/care-requests" element={<CareRequestsPage api={api} />} />
                    <Route path="/accounts" element={<AccountsPage />} />
                    <Route path="/availability" element={<CaregiverAvailabilityPage api={api} />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="/documents" element={<DocumentsPage />} />
                    <Route path="/clients" element={<ClientsPage />} />
                    <Route path="/clients/:clientId" element={<ClientDetailPage />} />
                    <Route path="/compliance" element={<ComplianceHoldsPage />} />
                    <Route path="/care-team" element={<CareTeamPage />} />
                    <Route path="/care-team/services-review" element={<ServicesReviewPage />} />
                    <Route path="/care-team/recruiting" element={<RecruitingPage />} />
                    <Route path="/care-team/:caregiverRecordId" element={<CaregiverDetailPage />} />
                    <Route path="/services" element={<ServicesPage />} />
                    <Route path="/schedule" element={<SchedulePage />} />
                    <Route path="/my-shifts" element={<MyShiftsPage />} />
                    <Route path="/continuity" element={<ContinuityPage />} />
                    <Route path="/outage-visits" element={<OutageVisitsPage />} />
                    <Route path="/attention" element={<NeedsAttentionPage />} />
                    <Route path="/action-needed" element={<ActionNeededPage />} />
                    <Route path="/reporting" element={<ReportingPage />} />
                    <Route path="/authorization-impacts" element={<AuthorizationImpactsPage />} />
                    <Route path="/staffing" element={<UpcomingStaffingPage />} />
                    <Route path="/visit-review" element={<VisitQueuePage />} />
                    <Route path="/authorizations/rates" element={<RatesReviewPage />} />
                    <Route path="/settings/appearance" element={<AppearancePage />} />
                    <Route path="/settings/branding" element={<BrandingSettingsPage />} />
                    <Route path="/settings/billing-rounding" element={<BillingRoundingSettingsPage />} />
                    <Route path="/settings/visit-rules" element={<VisitRulesPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AwsShell>
              </AwsBackendProvider>
            </AwsOrganizationProvider>
          </AwsProtectedRoute>
        }
      />
    </Routes>
  );
}

export function AwsApp({ runtime }: { runtime: AwsRuntime }) {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <CognitoAuthProvider client={runtime.auth}>
          <EnvironmentProvider marker={runtime.environment}>
            <AwsRoutes api={runtime.api} publicApi={runtime.publicApi} />
          </EnvironmentProvider>
        </CognitoAuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

export function AwsConfigurationError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center">
        <p className="text-sm font-medium text-slate-900">This Ogevia build is not configured correctly.</p>
        <p className="mt-1 text-sm text-slate-600">{message}</p>
      </div>
    </div>
  );
}
