import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import type { Assignment } from "./assignments-card";

export function useAssignments(filter: { clientId?: string | undefined; caregiverRecordId?: string | undefined }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-assignments", activeOrganizationId, filter.clientId ?? null, filter.caregiverRecordId ?? null],
    queryFn: async () =>
      (await api.get<{ assignments: Assignment[] }>("/v1/assignments", {
        organizationId: activeOrganizationId,
        ...(filter.clientId ? { clientId: filter.clientId } : {}),
        ...(filter.caregiverRecordId ? { caregiverRecordId: filter.caregiverRecordId } : {}),
      })).assignments,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
  });
}
