import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { LoginPage } from "@/pages/login-page";
import { OverviewPage } from "@/pages/overview-page";
import { AccessPage } from "@/pages/access-page";
import { OrganizationsPage } from "@/pages/organizations-page";
import { AuditPage } from "@/pages/audit-page";
import { SettingsPage } from "@/pages/settings-page";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <OrganizationProvider>
              <AppShell>
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/organizations" element={<OrganizationsPage />} />
                  <Route path="/access" element={<AccessPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </AppShell>
            </OrganizationProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
