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

export function OrganizationProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(
    () => window.localStorage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY)
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
        .select("id, slug, legal_name, display_name, status, timezone")
        .order("display_name");
      if (error) throw error;
      return data.map((row) =>
        organizationSchema.parse({
          id: row.id,
          slug: row.slug,
          legalName: row.legal_name,
          displayName: row.display_name,
          status: row.status,
          timezone: row.timezone
        })
      );
    },
    enabled: !!user
  });

  const organizations = organizationsQuery.data ?? [];

  useEffect(() => {
    const [firstOrganization] = organizations;
    if (!firstOrganization) return;
    const stillVisible = organizations.some((org) => org.id === activeOrganizationId);
    if (!stillVisible) {
      setActiveOrganizationIdState(firstOrganization.id);
    }
  }, [organizations, activeOrganizationId]);

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
      loading
    }),
    [organizations, activeOrganization, activeOrganizationId, role, isPlatformOwner, permissions, loading]
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error("useOrganization must be used within OrganizationProvider");
  return value;
}
