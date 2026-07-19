import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { LoginPage } from "@/pages/login-page";
import { OverviewPage } from "@/pages/overview-page";
import { AccessPage } from "@/pages/access-page";
import { CaregiverDetailPage } from "@/pages/caregiver-detail-page";
import { OrganizationsPage } from "@/pages/organizations-page";
import { AuditPage } from "@/pages/audit-page";
import { ClientsPage } from "@/pages/clients-page";
import { ClientDetailPage } from "@/pages/client-detail-page";
import { SchedulePage } from "@/pages/schedule-page";
import { CredentialsPage } from "@/pages/credentials-page";
import { AuthorizationsPage } from "@/pages/authorizations-page";
import { IncidentsPage } from "@/pages/incidents-page";
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
                  <Route path="/team/:id" element={<CaregiverDetailPage />} />
                  <Route path="/clients" element={<ClientsPage />} />
                  <Route path="/clients/:id" element={<ClientDetailPage />} />
                  <Route path="/schedule" element={<SchedulePage />} />
                  <Route path="/credentials" element={<CredentialsPage />} />
                  <Route path="/authorizations" element={<AuthorizationsPage />} />
                  <Route path="/incidents" element={<IncidentsPage />} />
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
