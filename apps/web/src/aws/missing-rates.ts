import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export interface MissingRate {
  authorizationId: string; clientId: string; clientCode: string; clientName: string | null; serviceCode: string; serviceName: string;
  payer: string | null; periodStart: string; periodEnd: string; monthlyAuthorizedMinutes: number;
}

export function useMissingRates(monthStart: string, enabled = true) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["authorizations-missing-rate", activeOrganizationId, monthStart],
    queryFn: async () => (await api.get<{ authorizations: MissingRate[] }>("/v1/authorizations/missing-rate", { organizationId: activeOrganizationId, monthStart })).authorizations,
    enabled: enabled && !!activeOrganizationId && hasPermission("billing.read"),
  });
}

