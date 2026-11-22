// Offices (0110, behind the offices release switch): data hooks and the one filter rule. Where the switch is off the routes do not exist and the browser
// sees a failed request, not a clean 404, so `available` is true only when the list actually loaded.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";

export interface OfficeRow {
  officeId: string; name: string; isActive: boolean; clientCount: number;
  addressLine1?: string | null; city?: string | null; postalCode?: string | null; county?: string | null; caregiverCount?: number;
}
export interface ClientOfficeRow { clientId: string; clientCode: string; officeId: string }
export interface PeopleFacets {
  clientOffices: Array<{ clientId: string; clientCode: string; officeId: string; isPrimary: boolean }>;
  caregiverOffices: Array<{ caregiverRecordId: string; caregiverCode: string; officeId: string; isPrimary: boolean }>;
  clientCounties: Array<{ clientId: string; county: string }>;
  caregiverCounties: Array<{ caregiverRecordId: string; county: string }>;
  caregiverColors: Array<{ caregiverRecordId: string; userId: string | null; color: string }>;
}

/** One rule for every Office filter: no choice shows everything; "none" shows people with no office; otherwise ANY of the person's offices (primary or secondary) must be the chosen one. */
export const officeMatches = (filter: string, offices: string | readonly string[] | undefined) => {
  const list = offices === undefined ? [] : typeof offices === "string" ? [offices] : offices;
  return !filter || (filter === "none" ? list.length === 0 : list.includes(filter));
};
/** One rule for every County filter: no choice shows everything; "none" shows people with no county; otherwise ANY of the person's counties must be the chosen one. */
export const countyMatches = (filter: string, counties: string | readonly string[] | undefined) => {
  const list = counties === undefined ? [] : typeof counties === "string" ? [counties] : counties;
  return !filter || (filter === "none" ? list.length === 0 : list.includes(filter));
};

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

const EMPTY: PeopleFacets = { clientOffices: [], caregiverOffices: [], clientCounties: [], caregiverCounties: [], caregiverColors: [] };
const group = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => string) => {
  const m = new Map<string, string[]>();
  for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), val(r)]); }
  return m;
};

/** Who is assigned to which offices (primary first), service counties and caregiver colours, from one read. `ready` is true only when it loaded (the office-assignment release must be live). */
export function usePeopleFacets(enabled = true) {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["people-facets", activeOrganizationId],
    queryFn: async () => (await api!.get<{ facets: PeopleFacets }>("/v1/people-facets", { organizationId: activeOrganizationId })).facets,
    enabled: enabled && !!api && !!activeOrganizationId,
    retry: false,
    staleTime: 30_000,
  });
  const f = q.data ?? EMPTY;
  return {
    ready: q.isSuccess,
    /** client id to office ids, the primary office first */
    clientOffices: group(f.clientOffices, (r) => r.clientId, (r) => r.officeId),
    clientOfficesByCode: group(f.clientOffices, (r) => r.clientCode, (r) => r.officeId),
    caregiverOffices: group(f.caregiverOffices, (r) => r.caregiverRecordId, (r) => r.officeId),
    clientCounty: new Map(f.clientCounties.map((r) => [r.clientId, r.county] as const)),
    caregiverCounties: group(f.caregiverCounties, (r) => r.caregiverRecordId, (r) => r.county),
    caregiverColor: new Map(f.caregiverColors.map((r) => [r.caregiverRecordId, r.color] as const)),
    caregiverColorByUser: new Map(f.caregiverColors.filter((r) => r.userId).map((r) => [r.userId as string, r.color] as const)),
  };
}

/** Kept for the Billing review and Reports filters (0110): a client's offices by id and by code, primary first. */
export function useClientOffices(enabled: boolean) {
  const f = usePeopleFacets(enabled);
  return { byClientId: f.clientOffices, byClientCode: f.clientOfficesByCode, ready: f.ready };
}

/** Assigns the chosen primary office to a record that was just created. Returns a short note when it could not be saved (the record itself was created). */
export async function assignOfficeAfterCreate(
  api: { post: (path: string, body: unknown) => Promise<unknown> }, organizationId: string | null, kind: "client" | "caregiver", id: string, officeId: string,
): Promise<string | null> {
  if (!officeId) return null;
  try {
    await api.post(kind === "client" ? `/v1/clients/${id}/offices` : `/v1/caregivers/${id}/offices`, { organizationId, primaryOfficeId: officeId, secondaryOfficeIds: [] });
    return null;
  } catch (cause) {
    return `The office was not saved (${cause instanceof Error ? cause.message : "check your connection"}). Open the record to assign it.`;
  }
}

