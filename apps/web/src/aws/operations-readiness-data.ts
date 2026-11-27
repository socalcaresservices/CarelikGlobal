// Is the operations readiness switch on? A quiet probe of the one route: success means yes; a failure (route not there, or no permission) means the link stays out of sight.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";

export function useOperationsReadinessAvailable(enabled = true): boolean {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["operations-readiness", activeOrganizationId], enabled: enabled && !!api && !!activeOrganizationId, retry: false, staleTime: 60_000,
    queryFn: async () => (await api!.get<{ readiness: unknown }>("/v1/operations-readiness", { organizationId: activeOrganizationId })).readiness,
  });
  return q.isSuccess;
}
