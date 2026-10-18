import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export interface DuplicateMatch { clientId: string; clientCode: string; firstName: string; lastName: string; status: string; match: "same_name" | "similar_name" }
export function useDuplicateClients(first: string, last: string, excludeClientId?: string) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const f = first.trim(), l = last.trim();
  return useQuery({
    queryKey: ["client-duplicates", activeOrganizationId, f.toLowerCase(), l.toLowerCase(), excludeClientId ?? null],
    enabled: !!activeOrganizationId && hasPermission("clients.names.read") && f.length >= 2 && l.length >= 2,
    queryFn: async () => (await api.get<{ matches: DuplicateMatch[] }>("/v1/client-duplicates", { organizationId: activeOrganizationId, firstName: f, lastName: l, excludeClientId: excludeClientId ?? null })).matches,
  });
}

export interface ReadinessService {
  serviceId: string; serviceName: string; unmet: number; state: "ready" | "needs_documents" | "held" | "authorization_expired";
  authorization: { periodStart: string; periodEnd: string; state: "valid" | "expired" | "not_started" };
  requirements: Array<{ documentTypeId: string; name: string; state: string }>;
  hold: { holdId: string; reason: string; openedAt: string; openedByName: string | null } | null;
}
export interface Readiness { clientId: string; status: string; stage: "draft" | "pending" | "active" | "on_hold" | "closed"; stageNote: string | null; canSchedule: boolean; ready: boolean; services: ReadinessService[] }
export const STAGE_LABEL: Record<Readiness["stage"], string> = { draft: "Draft", pending: "Pending", active: "Active", on_hold: "On hold", closed: "Closed" };
export function useClientReadiness(clientId: string) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["client-readiness", clientId], enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ readiness: Readiness }>(`/v1/clients/${encodeURIComponent(clientId)}/readiness`, { organizationId: activeOrganizationId })).readiness,
  });
}
