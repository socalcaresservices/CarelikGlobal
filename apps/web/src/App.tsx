import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { PlatformShell } from "@/layout/platform-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { PlatformProvider } from "@/providers/platform-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { getTenantRoutes } from "@/routes/tenant-routes";
import { getPlatformRoutes } from "@/routes/platform-routes";
import { useTenantContext } from "@/lib/use-tenant-context";
import { getRecoveryRedirectPath } from "@/lib/recovery-redirect";
import { LoginPage } from "@/pages/login-page";
import { SetPasswordPage } from "@/pages/set-password-page";
import { ResetPasswordPage } from "@/pages/reset-password-page";
import { ApplyPage } from "@/pages/apply-page";
import { CandidatePortalPage } from "@/pages/candidate-portal-page";
import { UploadPage } from "@/pages/upload-page";
import { AddOrganizationPage } from "@/pages/add-organization-page";
import { MarketingPage } from "@/pages/marketing-page";
import { PricingPage } from "@/pages/pricing-page";

export function App() {
  const { context: tenantContext, loading } = useTenantContext();
  const navigate = useNavigate();
  const isMarketing = tenantContext.type === "marketing";
  const isAdmin = tenantContext.type === "admin";
  const isTenantWorkspace = tenantContext.type === "app" || tenantContext.type === "tenant";

  useEffect(() => {
    const redirectPath = getRecoveryRedirectPath(
      window.location.pathname,
      window.location.search,
      window.location.hash
    );
    if (redirectPath) navigate(redirectPath, { replace: true });
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/apply/:orgSlug" element={<ApplyPage />} />
      <Route path="/candidate/:token" element={<CandidatePortalPage />} />
      <Route path="/upload/:token" element={<UploadPage />} />

      {isMarketing && <Route path="/" element={<MarketingPage />} />}
      {isMarketing && <Route path="/pricing" element={<PricingPage />} />}
      {isMarketing && <Route path="*" element={<Navigate to="/" replace />} />}

      {isTenantWorkspace && (
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <OrganizationProvider
                tenantSlug={tenantContext.type === "tenant" ? tenantContext.slug : undefined}
              >
                <AppShell>
                  <Routes>
                    {getTenantRoutes()}
                    <Route path="/organizations/new" element={<AddOrganizationPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AppShell>
              </OrganizationProvider>
            </ProtectedRoute>
          }
        />
      )}

      {isAdmin && (
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <OrganizationProvider>
                <PlatformProvider>
                  <PlatformShell>
                    <Routes>
                      {getPlatformRoutes()}
                      <Route path="*" element={<Navigate to="/organizations" replace />} />
                    </Routes>
                  </PlatformShell>
                </PlatformProvider>
              </OrganizationProvider>
            </ProtectedRoute>
          }
        />
      )}
    </Routes>
  );
}
