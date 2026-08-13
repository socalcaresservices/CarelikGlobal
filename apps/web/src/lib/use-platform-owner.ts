import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { supabase } from "@/lib/supabase";

/**
 * The single source of truth for "is this signed-in user a platform
 * owner," for anywhere that needs it outside an organization context
 * (platform routes mount no OrganizationProvider - there's no single
 * organization to scope to there). Reads user_profiles.platform_role
 * directly, the same column and the same "never derive this from email
 * or any client-side state" rule useOrganization()'s isPlatformOwner
 * follows inside the org-scoped tree - see that provider's regression
 * test for the exact spoofing scenario this guards against.
 */
export function useIsPlatformOwner() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ["platform-role", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("platform_role")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data?.platform_role === "platform_owner";
    },
    enabled: !!user
  });

  return { isPlatformOwner: query.data ?? false, loading: !!user && query.isLoading };
}
