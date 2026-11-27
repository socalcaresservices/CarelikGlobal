import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";

export interface OverrideRecord {
  id: string; caregiverRecordId: string; caregiverCode: string; caregiverName: string; requirement: "cpr" | "tb"; issueStatus: string; issueLabel: string; validUntil: string | null;
  reason: string; approvedByName: string | null; approvedAt: string; active: boolean; revokedAt: string | null; revokedByName: string | null; revokeReason: string | null; stillApplies: boolean;
}
export const REFRESH = ["caregiver-readiness", "caregiver-compliance", "compliance-holds", "readiness-overrides", "aws-caregivers", "aws-action-issues", "aws-attention", "readiness", "document-readiness"] as const;

/** The overrides read. `available` is true only where the release switch is on and the caller may read compliance: the Approve action is offered only then. */
export function useReadinessOverrides(caregiverRecordId: string | null, enabled: boolean) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["readiness-overrides", activeOrganizationId, caregiverRecordId ?? "all"],
    queryFn: async () => (await api.get<{ overrides: OverrideRecord[] }>("/v1/readiness-overrides", { organizationId: activeOrganizationId, ...(caregiverRecordId ? { caregiverRecordId } : {}) })).overrides,
    enabled: !!activeOrganizationId && enabled, retry: false, staleTime: 15_000,
  });
  return { available: q.isSuccess, rows: q.data ?? [], isLoading: q.isLoading };
}

