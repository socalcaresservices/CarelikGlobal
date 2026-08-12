import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import {
  organizationSchema,
  permissionSchema,
  type Organization,
  type Permission,
  type SystemRole
} from "@carelik/shared";
import { supabase } from "@/lib/supabase";

const ACTIVE_ORGANIZATION_STORAGE_KEY = "carelik.activeOrganizationId";

// A stable reference for the "no data yet" case: `data ?? []` would create
// a new array every render, which defeats the point of the dependency
// arrays below (they'd see a "new" organizations value on every render).
const EMPTY_ORGANIZATIONS: Organization[] = [];

interface OrganizationContextValue {
  organizations: Organization[];
  activeOrganization: Organization | null;
  activeOrganizationId: string | null;
  setActiveOrganizationId: (organizationId: string) => void;
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

export function OrganizationProvider({
  children,
  tenantSlug
}: PropsWithChildren<{
  /**
   * The slug App.tsx's hostname resolution (resolveTenant()/
   * useTenantContext()) decided this request belongs to - e.g. the
   * subdomain, or the organization behind a matched custom domain.
   * Undefined on platform routes, where there's no single tenant to pin
   * to and the existing cached/first-org fallback below still applies.
   *
   * Without this, a user who belongs to more than one organization
   * (the common case for anyone testing multiple tenants, or a platform
   * owner who is also a real member somewhere) would see whichever
   * organization happened to be cached in *this browser's* localStorage
   * from a previous visit, regardless of which tenant's hostname they
   * actually navigated to - the exact bug found live 2026-08-09: the
   * custom-domain lookup correctly resolved to Socal Care Services llc,
   * but the app still showed the wrong org because that was this browser's
   * last-active org from unrelated local testing.
   */
  tenantSlug?: string | undefined;
}>) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(
    () => window.localStorage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY)
  );
  // A one-time deep-link preference read from ?org=<slug> - used by the
  // platform Organizations registry's "Enter organization" link
  // (toAppUrl() + "?org=" + slug) so picking an org there lands on that
  // org on app.ogevia.com, rather than whatever was last active in this
  // browser. Only relevant when tenantSlug is unset (the app/platform
  // case); cleared once successfully applied so it doesn't keep
  // overriding a later manual switch.
  const [preferredOrgSlug, setPreferredOrgSlug] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("org")
  );

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

  const organizationsQuery = useQuery({
    queryKey: ["organizations", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select(
          "id, slug, legal_name, display_name, status, timezone, logo_url, primary_color, secondary_color, accent_color, theme_mode, show_powered_by"
        )
        .order("display_name");
      if (error) throw error;
      return data.map((row) =>
        organizationSchema.parse({
          id: row.id,
          slug: row.slug,
          legalName: row.legal_name,
          displayName: row.display_name,
          status: row.status,
          timezone: row.timezone,
          logoUrl: row.logo_url,
          primaryColor: row.primary_color,
          secondaryColor: row.secondary_color,
          accentColor: row.accent_color,
          themeMode: row.theme_mode,
          showPoweredBy: row.show_powered_by
        })
      );
    },
    enabled: !!user
  });

  const organizations = organizationsQuery.data ?? EMPTY_ORGANIZATIONS;

  useEffect(() => {
    const [firstOrganization] = organizations;
    if (!firstOrganization) return;

    // The hostname decides the tenant here, full stop - not a cached
    // value from a previous visit to a different tenant on the same
    // browser. Re-asserted on every organizations change (not just once)
    // so switching hosts without a hard reload can't leave a stale org
    // active either.
    if (tenantSlug) {
      const matching = organizations.find((org) => org.slug === tenantSlug);
      if (matching && matching.id !== activeOrganizationId) {
        setActiveOrganizationIdState(matching.id);
      }
      return;
    }

    if (preferredOrgSlug) {
      const preferred = organizations.find((org) => org.slug === preferredOrgSlug);
      if (preferred) {
        if (preferred.id !== activeOrganizationId) {
          setActiveOrganizationIdState(preferred.id);
        }
        setPreferredOrgSlug(null);
        return;
      }
    }

    const stillVisible = organizations.some((org) => org.id === activeOrganizationId);
    if (!stillVisible) {
      setActiveOrganizationIdState(firstOrganization.id);
    }
  }, [organizations, activeOrganizationId, tenantSlug, preferredOrgSlug]);

  useEffect(() => {
    if (activeOrganizationId) {
      window.localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, activeOrganizationId);
    }
  }, [activeOrganizationId]);

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

  const activeOrganization = organizations.find((org) => org.id === activeOrganizationId) ?? null;

  const role: SystemRole | "platform_owner" | null = isPlatformOwner
    ? "platform_owner"
    : membershipRoleQuery.data ?? null;

  const loading =
    profileQuery.isLoading ||
    organizationsQuery.isLoading ||
    (!isPlatformOwner && !!activeOrganizationId && membershipRoleQuery.isLoading);

  const value = useMemo<OrganizationContextValue>(
    () => ({
      organizations,
      activeOrganization,
      activeOrganizationId,
      setActiveOrganizationId: setActiveOrganizationIdState,
      role,
      isPlatformOwner,
      hasPermission: (permission) => isPlatformOwner || permissions.has(permission),
      loading,
      userDisplayName
    }),
    [
      organizations,
      activeOrganization,
      activeOrganizationId,
      role,
      isPlatformOwner,
      permissions,
      loading,
      userDisplayName
    ]
  );

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
