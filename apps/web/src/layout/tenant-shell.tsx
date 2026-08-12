import type { PropsWithChildren } from "react";
import { AppShell } from "@/layout/app-shell";
import { StaffShell } from "@/layout/staff-shell";
import { useOrganization } from "@/providers/organization-provider";

// Picks the actual shell for a signed-in tenant-workspace user based on
// their role in the active organization - AppShell (full agency
// operations workspace) for everyone except the caregiver role, which
// gets the separate, simplified StaffShell. This is the concrete
// implementation of the OGEVIA SaaS structure spec's mandatory §20:
// "Staff/caregiver context may get StaffShell... Do not reuse one
// sidebar with different visibility hacks if that produces mixed
// experiences." Both shells wrap the exact same route tree
// (getTenantRoutes()) - which pages a caregiver can actually reach
// (and what those pages return) is still entirely governed by RLS/
// has_permission() server-side, unchanged by this split. This only
// changes which chrome wraps those same, unmodified pages.
export function TenantShell({ children }: PropsWithChildren) {
  const { role } = useOrganization();

  if (role === "caregiver") {
    return <StaffShell>{children}</StaffShell>;
  }

  return <AppShell>{children}</AppShell>;
}
