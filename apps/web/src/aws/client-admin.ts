// Client and authorization administration (0022): shared types, queries and
// pure helpers. All rules are enforced again by the server; these only make
// the screens clear.
import { useQuery } from "@tanstack/react-query";
import type { AuthorizationTier } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export type ClientStatus = "active" | "inactive" | "discharged";

export interface AdminClient {
  clientId: string;
  clientCode: string;
  caregiverDisplayCode: string | null;
  status: ClientStatus;
  legalFirstName: string | null;
  legalLastName: string | null;
  city: string | null;
  clientTypeId: string | null;
  clientTypeName: string | null;
  currentAuthorizations: number;
  openVisits: number;
}

export interface ClientType {
  clientTypeId: string;
  name: string;
  isActive: boolean;
}

export interface AgencyService {
  serviceId: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface AuthorizationVersion {
  authorizationId: string;
  lineageId: string;
  versionNumber: number;
  isCurrent: boolean;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  payer: string;
  authorizationNumber: string | null;
  monthlyAuthorizedMinutes: number;
  periodStart: string;
  periodEnd: string;
  receivedDate: string | null;
  sourceReference: string | null;
  changeReason: string | null;
  createdAt: string;
  createdByName: string | null;
  /** Administrator only (billing.read); null for everyone else. */
  hourlyRateCents: number | null;
}

export interface MonthlyBalance {
  serviceId: string;
  serviceName: string;
  authorizationLineageId: string;
  authorizedMinutes: number;
  workedMinutes: number;
  billableMinutes: number;
  /** Authorized - committed, SIGNED: negative when over the limit (0057). */
  remainingMinutes: number;
  reviewMinutes: number;
  reservedMinutes?: number;
  adjustmentMinutes?: number;
  /** Billable + approved rounding adjustments + reserved: the approved definition of utilization. */
  committedMinutes?: number;
  overLimitMinutes?: number;
  utilizationPercent?: number | null;
  authorizationTier?: AuthorizationTier | null;
  authorizationPeriodEnd?: string;
  daysUntilExpiry?: number;
  expiringSoon?: boolean;
}

export const STATUS_LABEL: Record<ClientStatus, string> = { active: "Active", inactive: "Inactive", discharged: "Discharged" };
export const STATUS_BADGE: Record<ClientStatus, string> = {
  active: "bg-emerald-100 text-emerald-900",
  inactive: "bg-amber-100 text-amber-900",
  discharged: "bg-slate-200 text-slate-800",
};

export const clientName = (c: Pick<AdminClient, "legalFirstName" | "legalLastName">) =>
  [c.legalFirstName, c.legalLastName].filter(Boolean).join(" ") || null;

/** "30", "30.5", "7:30" (hours[:minutes]) -> whole minutes; null if not a valid amount. */
export function hoursToMinutes(input: string): number | null {
  const v = input.trim();
  let minutes: number;
  const hm = /^(\d{1,3}):([0-5]\d)$/.exec(v);
  if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2]);
  else if (/^\d{1,3}(\.\d{1,2})?$/.test(v)) minutes = Math.round(Number(v) * 60);
  else return null;
  return minutes >= 1 && minutes <= 44640 ? minutes : null;
}

/** "$25.50" / "25.5" -> cents; null when empty; NaN when invalid. */
export function dollarsToCents(input: string): number | null {
  const v = input.trim().replace(/^\$/, "");
  if (!v) return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const cents = Math.round(Number(v) * 100);
  return cents <= 100000 ? cents : Number.NaN;
}

export const formatRate = (cents: number) => `$${(cents / 100).toFixed(2)}/hr`;

export function useClients() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-clients", activeOrganizationId],
    queryFn: async () => (await api.get<{ clients: AdminClient[] }>("/v1/clients", { organizationId: activeOrganizationId })).clients,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
  });
}

export function useClientTypes() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["aws-client-types", activeOrganizationId],
    queryFn: async () => (await api.get<{ clientTypes: ClientType[] }>("/v1/client-types", { organizationId: activeOrganizationId })).clientTypes,
    enabled: !!activeOrganizationId,
  });
}

export function useServices() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-services", activeOrganizationId],
    queryFn: async () => (await api.get<{ services: AgencyService[] }>("/v1/services", { organizationId: activeOrganizationId })).services,
    enabled: !!activeOrganizationId && hasPermission("authorizations.read"),
  });
}

export function useClientAuthorizations(clientId: string | undefined) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-client-authorizations", activeOrganizationId, clientId],
    queryFn: async () =>
      (await api.get<{ authorizations: AuthorizationVersion[] }>(`/v1/clients/${encodeURIComponent(clientId!)}/authorizations`, { organizationId: activeOrganizationId }))
        .authorizations,
    enabled: !!activeOrganizationId && !!clientId && hasPermission("authorizations.read"),
  });
}

/** Balances come from the same server calculation as the reports (list_monthly_service_summary). */
export function useMonthlyBalances(clientId: string | undefined, monthStart: string) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-client-balances", activeOrganizationId, clientId, monthStart],
    queryFn: async () =>
      (await api.get<{ services: MonthlyBalance[] }>("/v1/reports/monthly-service-summary", { organizationId: activeOrganizationId, clientId: clientId!, monthStart }))
        .services,
    enabled: !!activeOrganizationId && !!clientId && hasPermission("visits.read"),
  });
}

/** Versions grouped by lineage: current version first, then its history. */
export function groupByLineage(versions: AuthorizationVersion[]) {
  const map = new Map<string, AuthorizationVersion[]>();
  for (const v of versions) map.set(v.lineageId, [...(map.get(v.lineageId) ?? []), v]);
  return Array.from(map.values())
    .map((list) => list.sort((a, b) => b.versionNumber - a.versionNumber))
    .sort((a, b) => (b[0]!.periodStart > a[0]!.periodStart ? 1 : b[0]!.periodStart < a[0]!.periodStart ? -1 : a[0]!.serviceName.localeCompare(b[0]!.serviceName)));
}
