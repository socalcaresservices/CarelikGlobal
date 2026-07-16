import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/app-shell";
import { OverviewPage } from "@/pages/overview-page";
import { NotImplementedPage } from "@/pages/not-implemented-page";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/organizations" element={<NotImplementedPage title="Organizations" />} />
        <Route path="/access" element={<NotImplementedPage title="Access control" />} />
        <Route path="/settings" element={<NotImplementedPage title="Settings" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
