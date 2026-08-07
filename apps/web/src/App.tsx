import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { PlatformShell } from "@/layout/platform-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { PlatformProvider } from "@/providers/platform-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { getTenantRoutes } from "@/routes/tenant-routes";
import { getPlatformRoutes } from "@/routes/platform-routes";
import { resolveTenant } from "@/lib/tenant-resolver";
import { LoginPage } from "@/pages/login-page";
import { SetPasswordPage } from "@/pages/set-password-page";
import { ApplyPage } from "@/pages/apply-page";
import { UploadPage } from "@/pages/upload-page";
import { AddOrganizationPage } from "@/pages/add-organization-page";

export function App() {
  const tenantContext = resolveTenant(window.location.hostname);
  const isPlatform = tenantContext.type === "platform";

  return (
    <Routes>
      {/* Public routes - accessible without auth, on any host */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/apply/:orgSlug" element={<ApplyPage />} />
      <Route path="/upload/:token" element={<UploadPage />} />

      {/* Tenant routes (agency workspace) */}
      {!isPlatform && (
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <OrganizationProvider>
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

      {/* Platform routes (carelik management) */}
      {isPlatform && (
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
