import { useQuery } from "@tanstack/react-query";
import { isOwnDomain, resolveTenant, type TenantContext } from "@/lib/tenant-resolver";
import { supabase } from "@/lib/supabase";

interface CustomDomainMatch {
  slug: string;
  display_name: string;
}

/**
 * Resolves platform-vs-tenant for the current hostname. Wraps
 * resolveTenant() with an async fallback for a hostname that isn't one
 * of Ogevia's own domains, checked against organizations.custom_domain
 * via the public resolve_tenant_domain() RPC (see
 * 20260809022627_custom_domain_tenant_resolution.sql).
 *
 * The common case - Ogevia's own domains - never touches the network:
 * resolveTenant() already answers those synchronously, and the RPC-backed
 * query is disabled entirely for them. Only an unrecognized hostname
 * (a candidate custom domain) pays for the round trip, and loading is
 * true only for that case - App.tsx uses it to hold off rendering routes
 * until the lookup settles, since which provider tree to mount depends
 * on the answer.
 */
export function useTenantContext(): { context: TenantContext; loading: boolean } {
  const hostname = window.location.hostname;
  const ownDomain = isOwnDomain(hostname);

  const customDomainQuery = useQuery({
    queryKey: ["tenant-custom-domain", hostname],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("resolve_tenant_domain", { hostname });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as CustomDomainMatch | null;
    },
    enabled: !ownDomain,
    staleTime: Infinity,
    // No retry: this gates the whole app's render (App.tsx won't pick a
    // route tree until loading is false), so a failed lookup should
    // fail closed to the platform default quickly rather than leave the
    // user on a loading screen through a retry backoff.
    retry: false
  });

  if (ownDomain) {
    return { context: resolveTenant(hostname), loading: false };
  }

  if (customDomainQuery.isLoading) {
    return { context: { type: "platform" }, loading: true };
  }

  // No match (including on error - fail closed to the platform default
  // rather than guessing) means this genuinely isn't a configured
  // tenant domain.
  const match = customDomainQuery.data;
  return {
    context: match ? { type: "tenant", slug: match.slug } : { type: "platform" },
    loading: false
  };
}
