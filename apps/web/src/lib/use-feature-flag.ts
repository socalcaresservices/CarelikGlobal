import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

interface FeatureFlagLookupRow {
  organization_id: string | null;
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

/**
 * Reads public.feature_flags (Build 024's Platform Administration UI is
 * the write side - see feature-flags-page.tsx) for the current
 * organization. A row scoped to this organization takes precedence over
 * a global (organization_id null) row for the same key, so a platform
 * owner can turn a global flag on everywhere and still opt one
 * organization out (or the reverse) with a single extra row - no
 * separate "override" concept needed.
 *
 * Returns false while loading and for any key with no matching row,
 * so a component using this can treat "flag off" and "flag not
 * configured yet" identically, which is the correct default for a
 * kill-switch/rollout tool - unconfigured means not rolled out yet.
 */
export function useFeatureFlag(key: string): boolean {
  const { activeOrganizationId } = useOrganization();

  const query = useQuery({
    queryKey: ["feature-flag", key, activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_flags")
        .select("organization_id, enabled, starts_at, ends_at")
        .eq("key", key)
        .or(`organization_id.is.null,organization_id.eq.${activeOrganizationId}`);
      if (error) throw error;
      return (data ?? []) as FeatureFlagLookupRow[];
    },
    enabled: !!key
  });

  const rows = query.data ?? [];
  if (rows.length === 0) return false;

  const scoped = rows.find((row) => row.organization_id === activeOrganizationId);
  const row = scoped ?? rows.find((row) => row.organization_id === null);
  if (!row || !row.enabled) return false;

  const now = Date.now();
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return false;
  if (row.ends_at && new Date(row.ends_at).getTime() < now) return false;

  return true;
}
