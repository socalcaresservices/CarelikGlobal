// Offices (0110, behind the offices release switch): data hooks and the one filter rule. Where the switch is off the routes do not exist and the browser
// sees a failed request, not a clean 404, so `available` is true only when the list actually loaded.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";

export interface OfficeRow { officeId: string; name: string; isActive: boolean; clientCount: number }
export interface ClientOfficeRow { clientId: string; clientCode: string; officeId: string }

/** One rule for every Office filter: no choice shows everything; "none" shows clients with no office; otherwise the client's office must be the chosen one. */
export const officeMatches = (filter: string, officeId: string | undefined) => !filter || (filter === "none" ? officeId === undefined : officeId === filter);


/** The agency's offices. `available` is true only when the list loaded: with the switch off, or for a role that may not see offices, it stays false. */
export function useOffices(enabled = true) {
  const api = useContext(AwsApiContext);   // not useAwsApi(): outside the AWS build (or in a test without it) the offices simply stay unavailable
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["offices", activeOrganizationId],
    queryFn: async () => (await api!.get<{ offices: OfficeRow[] }>("/v1/offices", { organizationId: activeOrganizationId })).offices,
    enabled: enabled && !!api && !!activeOrganizationId,
    retry: false,
    staleTime: 60_000,
  });
  return { offices: q.data ?? [], available: q.isSuccess, loading: q.isLoading };
}

/** client id and client code to office, for clients that have one. */
export function useClientOffices(enabled: boolean) {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["client-offices", activeOrganizationId],
    queryFn: async () => (await api!.get<{ clientOffices: ClientOfficeRow[] }>("/v1/client-offices", { organizationId: activeOrganizationId })).clientOffices,
    enabled: enabled && !!api && !!activeOrganizationId,
    retry: false,
    staleTime: 60_000,
  });
  const rows = q.data ?? [];
  return {
    byClientId: new Map(rows.map((r) => [r.clientId, r.officeId] as const)),
    byClientCode: new Map(rows.map((r) => [r.clientCode, r.officeId] as const)),
    ready: q.isSuccess,
  };
}
