import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo
} from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { permissionSchema, type Organization, type Permission, type SystemRole } from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { useMyOrganizations } from "@/lib/use-my-organizations";

interface OrganizationContextValue {
  organizations: Organization[];
  activeOrganization: Organization;
  activeOrganizationId: string;
  role: SystemRole | "platform_owner" | null;
  isPlatformOwner: boolean;
  hasPermission: (permission: Permission) => boolean;
  loading: boolean;
  /**
   * The signed-in user's own display name (from user_profiles), falling
   * back to the local part of their email. Used anywhere the UI greets
   * the person by name instead of by raw system role - see AppShell's
   * header, which must never surface "platform_owner" as if it were an
   * agency-facing role label.
   */
  userDisplayName: string | null;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

/**
 * Resolves the active organization exclusively from the :orgSlug route
 * param - this only ever mounts under App.tsx's /org/:orgSlug/* route.
 * Never localStorage, never a ?org= query param, never a cached "last
 * active" fallback: the URL is the single source of truth for which
 * organization is active, per the Ogevia Architecture Reset directive -
 * "Correct flow: URL slug -> DB organization -> authenticated membership
 * -> organization UUID -> RLS." AppRootRedirect and SelectOrganizationPage
 * are what get a user to a valid /org/:slug URL in the first place; this
 * provider's only job once mounted is to confirm that slug is real *and*
 * this user is actually authorized into it (RLS-backed - the
 * organizations query below only ever returns rows is_organization_member()
 * allows) before rendering anything beneath it.
 */
export function OrganizationProvider({ children }: PropsWithChildren) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // A user can always read their own membership rows regardless of status
  // (see the "members_read_memberships" RLS policy), so once they've
  // authenticated we look for any pending invitations and activate them.
  // Until a membership is 'active', RLS hides the organization itself.
  useEffect(() => {
    if (!user) return;
    const currentUser = user;
    let cancelled = false;

    async function acceptPendingInvitations() {
      const { data: pending, error } = await supabase
        .from("organization_memberships")
        .select("organization_id")
        .eq("user_id", currentUser.id)
        .eq("status", "invited");

      if (error || cancelled || !pending || pending.length === 0) return;

      await Promise.all(
        pending.map((row) =>
          supabase.rpc("accept_organization_invitation", {
            target_organization_id: row.organization_id
          })
        )
      );

      if (!cancelled) {
        void queryClient.invalidateQueries({ queryKey: ["organizations", currentUser.id] });
      }
    }

    void acceptPendingInvitations();

    return () => {
      cancelled = true;
    };
  }, [user, queryClient]);

  const profileQuery = useQuery({
    queryKey: ["user-profile", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("platform_role, display_name, first_name")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { platform_role: SystemRole | null; display_name: string | null; first_name: string | null } | null;
    },
    enabled: !!user
  });

  const isPlatformOwner = profileQuery.data?.platform_role === "platform_owner";

  const userDisplayName =
    profileQuery.data?.display_name ||
    profileQuery.data?.first_name ||
    user?.email?.split("@")[0] ||
    null;

  // Same query useMyOrganizations() feeds AppRootRedirect and
  // SelectOrganizationPage with (see that hook for the RLS scoping this
  // relies on) - shared, not duplicated, so React Query serves both from
  // one cached fetch.
  const { organizations, loading: organizationsLoading } = useMyOrganizations();
  const activeOrganization = organizations.find((org) => org.slug === orgSlug) ?? null;
  const activeOrganizationId = activeOrganization?.id ?? null;

  const membershipRoleQuery = useQuery({
    queryKey: ["membership-role", user?.id, activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organization_memberships")
        .select("role")
        .eq("organization_id", activeOrganizationId!)
        .eq("user_id", user!.id)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw error;
      return (data?.role as SystemRole | undefined) ?? null;
    },
    enabled: !!user && !!activeOrganizationId && !isPlatformOwner
  });

  const rolePermissionsQuery = useQuery({
    queryKey: ["role-permissions", membershipRoleQuery.data],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("permission_key")
        .eq("role", membershipRoleQuery.data!);
      if (error) throw error;
      return new Set(data.map((row) => permissionSchema.parse(row.permission_key)));
    },
    enabled: !isPlatformOwner && !!membershipRoleQuery.data
  });

  const permissions = useMemo(
    () => (isPlatformOwner ? new Set(permissionSchema.options) : rolePermissionsQuery.data ?? new Set<Permission>()),
    [isPlatformOwner, rolePermissionsQuery.data]
  );

  const role: SystemRole | "platform_owner" | null = isPlatformOwner
    ? "platform_owner"
    : membershipRoleQuery.data ?? null;

  const loading =
    profileQuery.isLoading ||
    organizationsLoading ||
    (!isPlatformOwner && !!activeOrganizationId && membershipRoleQuery.isLoading);

  // All hooks above run unconditionally on every render - the loading/
  // not-found states below only affect what gets returned, never how many
  // hooks are called, so this stays rules-of-hooks-safe even though it
  // branches before rendering children.
  const value = useMemo<OrganizationContextValue | null>(() => {
    if (!activeOrganization || !activeOrganizationId) return null;
    return {
      organizations,
      activeOrganization,
      activeOrganizationId,
      role,
      isPlatformOwner,
      hasPermission: (permission) => isPlatformOwner || permissions.has(permission),
      loading,
      userDisplayName
    };
  }, [
    organizations,
    activeOrganization,
    activeOrganizationId,
    role,
    isPlatformOwner,
    permissions,
    loading,
    userDisplayName
  ]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (!value) {
    // The same message whether :orgSlug doesn't exist at all or it exists
    // but this user isn't a member - RLS already hid the difference
    // (organizationsQuery simply never returned that row), and telling
    // those two cases apart here would leak which organization slugs
    // exist to someone with no right to know.
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-500">Organization</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h1>
          <p className="mt-3 text-slate-600">This organization doesn't exist, or you don't have access to it.</p>
          <Link to="/" className="mt-4 inline-block text-sm font-medium underline underline-offset-2">
            Go to your organizations
          </Link>
        </div>
      </div>
    );
  }

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

// Provider and its consumer hook are intentionally co-located, same as
// useAuth in packages/auth/src/auth-provider.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization must be used within OrganizationProvider");
  return value;
}
