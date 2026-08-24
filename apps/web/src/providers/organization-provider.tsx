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

// Scoped per user id, not a single flat key. Without this, signing out
// of one account and into a different one in the same browser (no full
// page reload - the OrganizationProvider component itself never
// unmounts) left the *previous* account's last-active organization id
// sitting in both localStorage and this provider's React state, with
// nothing forcing a re-read on the identity change. The "still visible"
// self-correction effect below is supposed to catch a stale id once the
// new user's own `organizations` list loads, but that still leaves a
// window - and every request issued before it fires - pointed at an
// organization the new user has no membership in at all, which is
// exactly the failure mode reported: RLS silently rejects the insert
// with a generic "row-level security policy" error that gives no hint
// the active organization itself was wrong. Scoping the key per user
// means a different account was simply never in a position to inherit
// it in the first place.
function storageKeyForUser(userId: string | undefined) {
  return userId ? `${ACTIVE_ORGANIZATION_STORAGE_KEY}.${userId}` : null;
}

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
    () => (typeof window !== "undefined" ? window.localStorage.getItem(storageKeyForUser(user?.id) ?? "") : null)
  );

  // Sets the active organization AND persists it in the same call, using
  // this render's own `user` - not a separate effect reacting to
  // `activeOrganizationId` changes on its own. A standalone persist
  // effect keyed on [activeOrganizationId, user?.id] has a real race on
  // an in-place account switch (no page reload): on the commit where
  // user?.id has just changed but activeOrganizationId is still the
  // *previous* account's cached value (state updates from the resync
  // effect below don't apply until the next render), that effect would
  // fire with the new user's id and the old user's still-stale org id,
  // writing it into the new user's own storage key - poisoning it with
  // another account's organization. Persisting only at the point a
  // caller actually chooses an organization (never from a bare "state
  // changed" reaction) closes that.
  function applyActiveOrganizationId(nextOrganizationId: string) {
    setActiveOrganizationIdState(nextOrganizationId);
    const key = storageKeyForUser(user?.id);
    if (key) {
      window.localStorage.setItem(key, nextOrganizationId);
    }
  }

  // Re-sync to this account's own cached value whenever the signed-in
  // identity changes - the initial useState above only runs once on
  // mount, before `useAuth()` may have resolved a user at all, and never
  // again on a later sign-out/sign-in within the same tab. Without this,
  // a second account signed into the same browser session would keep
  // rendering with whichever id happened to be in React state from
  // before, until the slower "still visible in my own org list"
  // correction effect below caught up - a window where every request
  // that account issues is scoped to an organization it was never a
  // member of. This only ever reads - it never persists - so it can't
  // itself write a stale value anywhere.
  useEffect(() => {
    const key = storageKeyForUser(user?.id);
    setActiveOrganizationIdState(key ? window.localStorage.getItem(key) : null);
  }, [user?.id]);
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
        .select("platform_role")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data?.platform_role as SystemRole | null;
    },
    enabled: !!user
  });

  const isPlatformOwner = profileQuery.data === "platform_owner";

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
        applyActiveOrganizationId(matching.id);
      }
      return;
    }

    if (preferredOrgSlug) {
      const preferred = organizations.find((org) => org.slug === preferredOrgSlug);
      if (preferred) {
        if (preferred.id !== activeOrganizationId) {
          applyActiveOrganizationId(preferred.id);
        }
        setPreferredOrgSlug(null);
        return;
      }
    }

    const stillVisible = organizations.some((org) => org.id === activeOrganizationId);
    if (!stillVisible) {
      applyActiveOrganizationId(firstOrganization.id);
    }
    // applyActiveOrganizationId is intentionally not a dependency - it's
    // redefined every render (it closes over the current `user`), and
    // this effect's own deps already capture everything that should
    // trigger it to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizations, activeOrganizationId, tenantSlug, preferredOrgSlug]);

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
      setActiveOrganizationId: applyActiveOrganizationId,
      role,
      isPlatformOwner,
      hasPermission: (permission) => isPlatformOwner || permissions.has(permission),
      loading
    }),
    // applyActiveOrganizationId is intentionally not a dependency - see
    // the comment on its definition; it closes over `user`, which
    // consumers of this context never need to know changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizations, activeOrganization, activeOrganizationId, role, isPlatformOwner, permissions, loading]
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
