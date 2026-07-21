import type { ReactNode } from "react";

// Wraps the "if (!hasPermission) return <Not available card>" pattern
// that's copy-pasted at the top of every page (team-page.tsx,
// caregiver-detail-page.tsx, credentials-page.tsx, ...) into one place.
// Deliberately takes the already-evaluated boolean rather than a
// permission key + org id itself - permission checking is
// app-specific (useOrganization().hasPermission), and this package has
// no knowledge of organizations or Supabase. That keeps this a plain,
// testable presentational component.
export interface PermissionGateProps {
  allowed: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}

export function PermissionGate({ allowed, fallback = null, children }: PermissionGateProps) {
  return <>{allowed ? children : fallback}</>;
}
