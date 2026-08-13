import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { TenantShell } from "@/layout/tenant-shell";
import { PlatformShell } from "@/layout/platform-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { RequirePlatformOwner } from "@/routes/require-platform-owner";
import { AppRootRedirect } from "@/routes/app-root-redirect";
import { getTenantRoutes } from "@/routes/tenant-routes";
import { getPlatformRoutes } from "@/routes/platform-routes";
import { resolveTenant } from "@/lib/tenant-resolver";
import { getRecoveryRedirectPath } from "@/lib/recovery-redirect";
import { LoginPage } from "@/pages/login-page";
import { SetPasswordPage } from "@/pages/set-password-page";
import { ResetPasswordPage } from "@/pages/reset-password-page";
import { ApplyPage } from "@/pages/apply-page";
import { UploadPage } from "@/pages/upload-page";
import { SelectOrganizationPage } from "@/pages/select-organization-page";
import { MarketingPage } from "@/pages/marketing-page";
import { PricingPage } from "@/pages/pricing-page";

// A relative <Navigate to="."> here would resolve against the wildcard
// route's own "*" pattern, not against "/org/:orgSlug" - not reliable
// enough to lean on. Reading :orgSlug directly and building the absolute
// path keeps this catch-all landing back inside the *same* organization
// (its Command Center) instead of bouncing out to AppRootRedirect, which
// an absolute Navigate to="/" would do.
function OrgHomeRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/org/${orgSlug}`} replace />;
}

/**
 * Ogevia Architecture Reset: two hosts, decided purely by hostname
 * (resolveTenant() - see tenant-resolver.ts) -
 *
 *   - ogevia.com (marketing): public, unauthenticated, no shell.
 *   - app.ogevia.com (app): everything authenticated - platform
 *     administration and every tenant workspace both live here, split by
 *     URL PATH, not by another hostname:
 *       - /platform/*      - RequirePlatformOwner-gated, no organization
 *                             context (there's no single tenant to scope
 *                             platform administration to).
 *       - /org/:orgSlug/*  - OrganizationProvider resolves :orgSlug to an
 *                             authorized organization (RLS-backed - see
 *                             that provider). This is the ONLY place an
 *                             organization is selected; nowhere in this
 *                             app reads a hostname or localStorage to
 *                             decide which tenant is active.
 *       - /                - AppRootRedirect: the one place that decides
 *                             where a freshly signed-in user lands
 *                             (platform home, straight into their one
 *                             organization, a chooser if they have more
 *                             than one, or a "no organization" message).
 *
 * There is no third "admin" or "tenant" host anymore - platform.ogevia.com
 * and {slug}.ogevia.com both no longer exist; see tenant-resolver.ts's
 * header comment for the full rationale.
 */
export function App() {
  const navigate = useNavigate();
  const isMarketing = resolveTenant(window.location.hostname).type === "marketing";

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

  return (
    <Routes>
      {/* Public routes - accessible without auth, on any host */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/apply/:orgSlug" element={<ApplyPage />} />
      <Route path="/upload/:token" element={<UploadPage />} />

      {/* Public marketing site - ogevia.com and any unrecognized host.
          app.ogevia.com's own "/" is handled by the app branch below,
          never this one. */}
      {isMarketing && <Route path="/" element={<MarketingPage />} />}
      {isMarketing && <Route path="/pricing" element={<PricingPage />} />}
      {isMarketing && <Route path="*" element={<Navigate to="/" replace />} />}

      {/* app.ogevia.com - authenticated app: platform administration and
          every tenant workspace, split by path. */}
      {!isMarketing && (
        <>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppRootRedirect />
              </ProtectedRoute>
            }
          />
          <Route
            path="/select-organization"
            element={
              <ProtectedRoute>
                <SelectOrganizationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/platform/*"
            element={
              <ProtectedRoute>
                <RequirePlatformOwner>
                  <PlatformShell>
                    <Routes>
                      {getPlatformRoutes()}
                      <Route path="*" element={<Navigate to="/platform/organizations" replace />} />
                    </Routes>
                  </PlatformShell>
                </RequirePlatformOwner>
              </ProtectedRoute>
            }
          />
          <Route
            path="/org/:orgSlug/*"
            element={
              <ProtectedRoute>
                <OrganizationProvider>
                  <TenantShell>
                    <Routes>
                      {getTenantRoutes()}
                      <Route path="*" element={<OrgHomeRedirect />} />
                    </Routes>
                  </TenantShell>
                </OrganizationProvider>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );
}
