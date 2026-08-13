import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { organizationSchema, type Organization } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

// A stable reference for the "no data yet" case: `data ?? []` would create
// a new array every render, which defeats the point of any dependency
// array built from it.
const EMPTY_ORGANIZATIONS: Organization[] = [];

/**
 * Every organization the signed-in user may see - deliberately
 * unfiltered, because members_read_organizations RLS
 * (is_organization_member(id), which is_platform_owner() short-circuits
 * to true) already scopes this correctly: every tenant for a platform
 * owner, only their own real memberships for anyone else.
 *
 * Shared by OrganizationProvider (the /org/:orgSlug-scoped context) and
 * AppRootRedirect/SelectOrganizationPage (deciding where "/" should send
 * a signed-in user, before any :orgSlug exists) - same query key, so
 * React Query serves both from one cached fetch rather than two.
 */
export function useMyOrganizations() {
  const { user } = useAuth();

  const query = useQuery({
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

  return { organizations: query.data ?? EMPTY_ORGANIZATIONS, loading: !!user && query.isLoading };
}
