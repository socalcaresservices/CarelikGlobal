// Queries shared by the readiness screens (kept out of the component files so hot reload keeps working).
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import type { AvailabilityState } from "./availability-section";
import type { ReadinessStatus } from "./readiness-card";
import type { ServiceApproval } from "./service-approvals";

export function useAvailability(caregiverRecordId?: string) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["availability", activeOrganizationId, caregiverRecordId ?? "me"],
    queryFn: async () => (await api.get<{ availability: AvailabilityState }>("/v1/availability", { organizationId: activeOrganizationId, caregiverRecordId })).availability,
    enabled: !!activeOrganizationId,
  });
}

export function useReadiness() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["readiness", activeOrganizationId],
    queryFn: async () => (await api.get<{ readiness: ReadinessStatus }>("/v1/readiness", { organizationId: activeOrganizationId })).readiness,
    enabled: !!activeOrganizationId && hasPermission("readiness.read"),
  });
}

export function useServiceApprovals(caregiverRecordId?: string) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["caregiver-services", activeOrganizationId, caregiverRecordId ?? "me"],
    queryFn: async () => (await api.get<{ approvals: ServiceApproval[] }>("/v1/caregiver-services", { organizationId: activeOrganizationId, caregiverRecordId })).approvals,
    enabled: !!activeOrganizationId,
  });
}

