// Types, text and the read hook for the client's service location (0118). Kept apart from the component so the screen file exports only a component.
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export interface ServiceLocation {
  city: string | null; zip: string | null; state: string; county: string | null;
  office: { officeId: string; name: string } | null; otherOffices: Array<{ officeId: string; name: string }>;
  missing: Array<"city" | "zip">; complete: boolean; countySuggestion: { county: string; basis: "zip_reference" | "agency_clients" } | null;
}
export const BASIS_TEXT: Record<string, string> = { zip_reference: "from the ZIP reference list", agency_clients: "from other clients with this ZIP" };
export const MISSING_WORD: Record<string, string> = { city: "city", zip: "ZIP code" };

/** One read of the client's service location; `available` is false where the switch is off (the route does not exist) or the person may not manage clients. */
export function useServiceLocation(clientId: string) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({ queryKey: ["service-location", clientId], queryFn: async () => (await api.get<{ location: ServiceLocation }>(`/v1/clients/${encodeURIComponent(clientId)}/service-location`, { organizationId: activeOrganizationId })).location,
    enabled: !!activeOrganizationId && !!clientId, retry: false, staleTime: 30_000 });
  return { location: q.data ?? null, available: q.isSuccess, loading: q.isLoading };
}

/** "Winchester, CA 92596 · Riverside County · Temecula office" with whatever is missing said plainly. */
export function locationSummary(l: ServiceLocation): string {
  const address = [l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter((x) => x && x.length > 0).join(", ");
  return [l.city || l.zip ? address : "No service address", l.county ? `${l.county} County` : "County not set", l.office ? `${l.office.name} office` : "No coordinating office"].join(" · ");
}
