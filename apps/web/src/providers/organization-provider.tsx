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
const EMPTY_PERMISSIONS: Set<Permission> = new Set();

interface OrganizationContextValue {
  organizations: Organization[];
  activeOrganization: Organization | null;
  activeOrganizationId: string | null;
  setActiveOrganizationId: (organizationId: string) => void;
  role: SystemRole | "platform_owner" | null;
  isPlatformOwner: boolean;
  hasPermission: (permission: Permission) => boolean;
  // False only for a platform owner viewing an organization they have no
  // real membership in and no active support_access_grant for - visible
  // to them (platform owners can see every organization's existence for
  // browsing/support purposes) but not actually actionable. Always true
  // for a regular member, since their own `organizations` list only ever
  // contains organizations they really belong to. Pages use this to warn
  // before a write is attempted, rather than letting a form render as
  // normal and fail with an RLS error the user can't act on.
  hasRealOrganizationAccess: boolean;
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

  // A platform owner's `organizations` list (above) includes every
  // organization in the system, not just ones they can actually act in -
  // `is_organization_member()` intentionally lets platform owners see
  // every org for browsing/support purposes (see organizations-page.tsx's
  // registry), independent of whether they hold real access anywhere.
  // Without knowing which of those are real, the "first organization"
  // fallback below has no way to avoid landing them in one they can only
  // view, not use - which is exactly what happened: "Ogethinks" sorts
  // alphabetically before every org this account actually belongs to.
  // Only fetched for platform owners; a regular member's own
  // `organizations` list already only ever contains real memberships; no
  // support-access concept applies to them.
  const myMembershipsQuery = useQuery({
    queryKey: ["my-memberships", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organization_memberships")
        .select("organization_id")
        .eq("user_id", user!.id)
        .eq("status", "active");
      if (error) throw error;
      return data.map((row) => row.organization_id as string);
    },
    enabled: isPlatformOwner && !!user
  });

  const myActiveSupportGrantsQuery = useQuery({
    queryKey: ["my-active-support-grants", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_access_grants")
        .select("organization_id")
        .eq("grantee_user_id", user!.id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString());
      if (error) throw error;
      return data.map((row) => row.organization_id as string);
    },
    enabled: isPlatformOwner && !!user
  });

  const realAccessOrgIds = useMemo(
    () => new Set([...(myMembershipsQuery.data ?? []), ...(myActiveSupportGrantsQuery.data ?? [])]),
    [myMembershipsQuery.data, myActiveSupportGrantsQuery.data]
  );

  useEffect(() => {
    if (organizations.length === 0) return;

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
    if (stillVisible) return;

    if (!isPlatformOwner) {
      applyActiveOrganizationId(organizations[0]!.id);
      return;
    }

    // Still waiting on the real-access lists - don't guess yet, the next
    // run of this effect (once they load) will pick correctly.
    if (myMembershipsQuery.isLoading || myActiveSupportGrantsQuery.isLoading) return;

    const realOrganization = organizations.find((org) => realAccessOrgIds.has(org.id));
    if (realOrganization) {
      applyActiveOrganizationId(realOrganization.id);
    }
    // No organization this platform owner has real access to - leave
    // activeOrganizationId unset rather than defaulting into a
    // visibility-only one. The Organizations registry (organizations-page.tsx)
    // is where they request support access; nothing in the regular app
    // should silently pick a broken default for them.
    // applyActiveOrganizationId is intentionally not a dependency - it's
    // redefined every render (it closes over the current `user`), and
    // this effect's own deps already capture everything that should
    // trigger it to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    organizations,
    activeOrganizationId,
    tenantSlug,
    preferredOrgSlug,
    isPlatformOwner,
    realAccessOrgIds,
    myMembershipsQuery.isLoading,
    myActiveSupportGrantsQuery.isLoading
  ]);

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
    enabled: !!user && !!activeOrganizationId
  });

  // Whether the signed-in platform owner currently holds active,
  // unexpired support access into `activeOrganizationId` - the same
  // condition public.has_active_support_access() checks server-side.
  // Only queried for platform owners; a regular member's access is
  // entirely determined by membershipRoleQuery above.
  const supportAccessQuery = useQuery({
    queryKey: ["support-access", user?.id, activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_access_grants")
        .select("id")
        .eq("organization_id", activeOrganizationId!)
        .eq("grantee_user_id", user!.id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isPlatformOwner && !!user && !!activeOrganizationId
  });

  const hasActiveSupportAccess = isPlatformOwner && !!supportAccessQuery.data;

  // Mirrors has_permission()'s own two conditions exactly: a platform
  // owner only bypasses role checks with an active support grant for
  // *this* organization; short of that, they fall back to whatever real
  // membership role they may separately hold here (membershipRoleQuery
  // above is no longer platform-owner-exempt, so this covers a platform
  // owner who is also a genuine member of an organization).
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
    enabled: !!membershipRoleQuery.data
  });

  const permissions = rolePermissionsQuery.data ?? EMPTY_PERMISSIONS;

  const activeOrganization = organizations.find((org) => org.id === activeOrganizationId) ?? null;

  const role: SystemRole | "platform_owner" | null = isPlatformOwner
    ? "platform_owner"
    : membershipRoleQuery.data ?? null;

  const hasRealOrganizationAccess = !isPlatformOwner || hasActiveSupportAccess || !!membershipRoleQuery.data;

  const loading =
    profileQuery.isLoading ||
    organizationsQuery.isLoading ||
    (!!activeOrganizationId && membershipRoleQuery.isLoading) ||
    (isPlatformOwner && !!activeOrganizationId && supportAccessQuery.isLoading);

  const value = useMemo<OrganizationContextValue>(
    () => ({
      organizations,
      activeOrganization,
      activeOrganizationId,
      setActiveOrganizationId: applyActiveOrganizationId,
      role,
      isPlatformOwner,
      // A platform owner with an active support grant for this
      // organization bypasses role checks entirely, same as
      // has_permission() does server-side - not a blanket "platform
      // owner can do anything" the way this used to read, which is
      // exactly why the Care Team form rendered as fully usable for an
      // owner who had never been granted access to the organization
      // they were viewing.
      hasPermission: (permission) => hasActiveSupportAccess || permissions.has(permission),
      hasRealOrganizationAccess,
      loading
    }),
    // applyActiveOrganizationId is intentionally not a dependency - see
    // the comment on its definition; it closes over `user`, which
    // consumers of this context never need to know changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      organizations,
      activeOrganization,
      activeOrganizationId,
      role,
      isPlatformOwner,
      hasActiveSupportAccess,
      permissions,
      hasRealOrganizationAccess,
      loading
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
