import type { PropsWithChildren } from "react";
import { useIsPlatformOwner } from "@/lib/use-platform-owner";

// The single gate for everything under app.ogevia.com/platform. PlatformShell's
// chrome and every platform page (Organizations, Subscriptions, Feature
// Flags, ...) sat behind ProtectedRoute (authenticated) alone,
// each independently deciding for itself whether the signed-in user was
// actually a platform owner - and PlatformShell didn't decide at all, it
// just always printed "Platform Super Admin". That let an authenticated
// non-owner see that label in the sidebar while Organizations correctly
// told them "Not available" one click away. Wrapping the whole platform
// route tree here means the shell and every page underneath it share one
// authorization result - both literally impossible to reach unless
// isPlatformOwner (user_profiles.platform_role = 'platform_owner', read
// directly via useIsPlatformOwner() - see
// supabase/migrations/20260715000100_platform_foundation.sql) is true.
// Deliberately doesn't use useOrganization(): /platform/* mounts no
// OrganizationProvider (platform administration isn't scoped to any one
// organization - see App.tsx), so this reads platform_role on its own.
export function RequirePlatformOwner({ children }: PropsWithChildren) {
  const { isPlatformOwner, loading } = useIsPlatformOwner();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (!isPlatformOwner) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h1>
          <p className="mt-3 text-slate-600">
            Only a Platform Super Admin can access platform administration.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
