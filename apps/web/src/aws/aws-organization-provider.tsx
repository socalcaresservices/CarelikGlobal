import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { permissionSchema, type Organization, type Permission, type SystemRole } from "@carelik/shared";
import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { AwsApiClient } from "@/lib/aws-api";
import { fetchMemberships, type AwsMembership } from "@/lib/sv-backend-aws";
import { OrganizationContextProvider, type OrganizationContextValue } from "@/providers/organization-provider";

const KNOWN_PERMISSIONS = new Set<string>(permissionSchema.options);
const ROLES = new Set<string>(["organization_owner", "organization_admin", "manager", "scheduler", "coordinator", "staff", "caregiver", "read_only"]);

export function toOrganization(m: AwsMembership): Organization {
  return {
    id: m.organizationId,
    slug: m.organizationSlug,
    legalName: m.organizationName,
    displayName: m.organizationName,
    status: "active",
    timezone: m.organizationTimezone,
    logoUrl: null,
  };
}

const selectionKey = (userId: string) => `ogevia.aws.activeOrganization.${userId}`;

/**
 * Organization context for the AWS build, from GET /v1/me. The role and
 * permissions only decide what the UI shows; every API call is authorized
 * again in PostgreSQL from the verified identity.
 */
export function AwsOrganizationProvider({ api, children }: PropsWithChildren<{ api: AwsApiClient }>) {
  const { user } = useAuth();
  const membershipsQuery = useQuery({
    queryKey: ["aws-memberships", user?.id],
    queryFn: () => fetchMemberships(api),
    enabled: !!user,
    staleTime: 60_000,
  });
  const memberships = membershipsQuery.data;
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    try {
      // Tab-scoped preference only (an id, not an authorization).
      setSelected(window.sessionStorage.getItem(selectionKey(user.id)));
    } catch {
      setSelected(null);
    }
  }, [user]);

  const value = useMemo<OrganizationContextValue>(() => {
    const list = memberships ?? [];
    const active = list.find((m) => m.organizationId === selected) ?? list[0] ?? null;
    const permissions = new Set((active?.permissions ?? []).filter((p) => KNOWN_PERMISSIONS.has(p)) as Permission[]);
    return {
      organizations: list.map(toOrganization),
      activeOrganization: active ? toOrganization(active) : null,
      activeOrganizationId: active?.organizationId ?? null,
      setActiveOrganizationId: (id: string) => {
        setSelected(id);
        try {
          if (user) window.sessionStorage.setItem(selectionKey(user.id), id);
        } catch {
          // storage unavailable: selection lasts for this page only
        }
      },
      role: active && ROLES.has(active.role) ? (active.role as SystemRole) : null,
      isPlatformOwner: false,
      hasPermission: (p: Permission) => permissions.has(p),
      loading: !!user && membershipsQuery.isLoading,
    };
  }, [memberships, membershipsQuery.isLoading, selected, user]);

  if (membershipsQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-slate-900">Your Ogevia access could not be loaded.</p>
          <p className="mt-1 text-sm text-slate-600">{(membershipsQuery.error as Error).message}</p>
          <button type="button" className="mt-4 text-sm font-medium text-slate-900 underline" onClick={() => void membershipsQuery.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <OrganizationContextProvider value={value}>{children}</OrganizationContextProvider>;
}
