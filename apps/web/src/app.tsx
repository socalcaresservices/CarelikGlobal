import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { OrganizationProvider } from "@/providers/organization-provider";
import { ProtectedRoute } from "@/routes/protected-route";
import { LoginPage } from "@/pages/login-page";
import { OverviewPage } from "@/pages/overview-page";
import { NotImplementedPage } from "@/pages/not-implemented-page";

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
                  <Route
                    path="/organizations"
                    element={<NotImplementedPage title="Organizations" />}
                  />
                  <Route path="/access" element={<NotImplementedPage title="Access control" />} />
                  <Route path="/settings" element={<NotImplementedPage title="Settings" />} />
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
