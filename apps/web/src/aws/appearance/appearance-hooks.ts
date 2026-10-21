import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { readCachedAppearance, SYSTEM_DEFAULTS, toEffective, type AppearanceState, type EffectiveAppearance, type PartialAppearance } from "./appearance";

export function useAppearanceState() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["appearance", activeOrganizationId],
    queryFn: async () => (await api.get<{ appearance: AppearanceState }>("/v1/appearance", { organizationId: activeOrganizationId })).appearance,
    enabled: !!activeOrganizationId,
    staleTime: 5 * 60_000,
  });
}

/** The choices in force for this person right now (their own, else the agency's, else the built-in defaults). */
export function useEffectiveAppearance(): EffectiveAppearance {
  const { user } = useAuth();
  const { activeOrganizationId } = useOrganization();
  const q = useAppearanceState();
  return q.data ? toEffective(q.data) : readCachedAppearance(user?.id, activeOrganizationId) ?? SYSTEM_DEFAULTS;
}

/** Mounted once in the shell: applies the effective choices to <html> and remembers them for the next first paint. */
type Level = "organization" | "me";
export function useSaveAppearance(level: Level) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (choices: PartialAppearance) =>
      (await api.post<{ appearance: AppearanceState }>(level === "organization" ? "/v1/appearance/organization" : "/v1/appearance/me", { organizationId: activeOrganizationId, ...choices })).appearance,
    onSuccess: (appearance) => {
      queryClient.setQueryData(["appearance", activeOrganizationId], appearance);
    },
  });
}
