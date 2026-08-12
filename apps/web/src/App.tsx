import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { TenantShell } from "@/layout/tenant-shell";
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
import { UploadPage } from "@/pages/upload-page";
import { AddOrganizationPage } from "@/pages/add-organization-page";
import { MarketingPage } from "@/pages/marketing-page";
import { PricingPage } from "@/pages/pricing-page";

export function App() {
  const { context: tenantContext, loading } = useTenantContext();
  const navigate = useNavigate();
  const isMarketing = tenantContext.type === "marketing";
  const isAdmin = tenantContext.type === "admin";
  // "app" (the shared app.ogevia.com host - org resolved from the signed-in
  // user's own memberships) and the legacy "tenant" ({slug}.ogevia.com,
  // still works whenever wildcard DNS is available) both mount the same
  // tenant workspace - see organization-provider.tsx for how tenantSlug
  // being undefined vs. set changes org resolution.
  const isTenantWorkspace = tenantContext.type === "app" || tenantContext.type === "tenant";

  // Safety net for a stale Supabase redirect-URL allowlist: if
  // resetPasswordForEmail's redirectTo isn't on that allowlist, Supabase
  // silently substitutes the project's bare Site URL instead, dropping
  // the /reset-password path and landing the recovery code/token on
  // whatever route that root happens to be (often the protected app
  // shell, which would just log the user in and never show a password
  // form). Recognizing the recovery marker anywhere and redirecting
  // client-side means the flow still works even if that dashboard
  // setting is wrong - see the password-recovery fix task for the exact
  // URLs that should be added there regardless.
  useEffect(() => {
    const redirectPath = getRecoveryRedirectPath(
      window.location.pathname,
      window.location.search,
      window.location.hash
    );
    if (redirectPath) {
      navigate(redirectPath, { replace: true });
    }
  }, [navigate]);

  // Which provider tree/routes to mount depends on tenantContext, so
  // hold off rendering until it settles. Only pays this cost on a
  // hostname that isn't one of Ogevia's own domains - see
  // useTenantContext()'s comment for why every other host resolves
  // synchronously with loading always false.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  return (
    <Routes>
      {/* Public routes - accessible without auth, on any host */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/apply/:orgSlug" element={<ApplyPage />} />
      <Route path="/upload/:token" element={<UploadPage />} />

      {/* Public marketing site - ogevia.com/carelik.com and any
          unrecognized host. app.ogevia.com's and admin.ogevia.com's own "/"
          are handled by their own branches below, never this one. */}
      {isMarketing && <Route path="/" element={<MarketingPage />} />}
      {isMarketing && <Route path="/pricing" element={<PricingPage />} />}
      {isMarketing && <Route path="*" element={<Navigate to="/" replace />} />}

      {/* App workspace - app.ogevia.com (org resolved from membership) and
          the legacy {slug}.ogevia.com path (org resolved from the slug). */}
      {isTenantWorkspace && (
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <OrganizationProvider
                tenantSlug={tenantContext.type === "tenant" ? tenantContext.slug : undefined}
              >
                <TenantShell>
                  <Routes>
                    {getTenantRoutes()}
                    <Route path="/organizations/new" element={<AddOrganizationPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </TenantShell>
              </OrganizationProvider>
            </ProtectedRoute>
          }
        />
      )}

      {/* Platform administration - admin.ogevia.com (and legacy
          platform.ogevia.com/platform.carelik.com). */}
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
