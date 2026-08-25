import { Navigate } from "react-router-dom";
import { CommandCenterPage } from "@/pages/command-center-page";
import { useOrganization } from "@/providers/organization-provider";

export function RoleLandingPage() {
  const { role, loading } = useOrganization();

  if (loading) {
    return <p className="text-sm text-slate-500">Opening your workspace…</p>;
  }

  if (role === "caregiver") {
    return <Navigate to="/service-verification" replace />;
  }

  return <CommandCenterPage />;
}
