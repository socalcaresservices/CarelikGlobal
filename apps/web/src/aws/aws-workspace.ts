// AWS build: agency workspace data (0020) - the signed-in person's name and
// view, agency branding, NEEDS ATTENTION counts and the utilisation
// overview. Every value is authorized again in PostgreSQL; the UI only
// decides what to show.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { createContext, useContext } from "react";
import type { AwsApiClient } from "@/lib/aws-api";
import { fetchMe } from "@/lib/sv-backend-aws";
import { useOrganization } from "@/providers/organization-provider";

export const AwsApiContext = createContext<AwsApiClient | null>(null);
export function useAwsApi(): AwsApiClient {
  const api = useContext(AwsApiContext);
  if (!api) throw new Error("useAwsApi outside the AWS build");
  return api;
}

export const meQueryKey = (userId: string | undefined) => ["aws-me", userId] as const;

export interface Branding {
  organizationId: string;
  displayName: string;
  accentColor: string | null;
  /** Changes whenever the owner replaces the logo; null when there is none. */
  logoSha256?: string | null;
}

/** The agency logo as a data URL, fetched through the API (the bucket is private). */
export function useLogo() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const branding = useBranding();
  const sha = branding.data?.logoSha256 ?? null;
  return useQuery({
    queryKey: ["aws-logo", activeOrganizationId, sha],
    queryFn: async () => {
      const r = await api.get<{ contentType: string; fileBase64: string }>("/v1/branding/logo", { organizationId: activeOrganizationId });
      return `data:${r.contentType};base64,${r.fileBase64}`;
    },
    enabled: !!activeOrganizationId && !!sha,
    staleTime: Infinity,
  });
}

export interface AttentionSummary {
  missingTimeOut: number;
  notConfirmed: number;
  needsReview: number;
  /** null when the viewer has no billing review permission. */
  billingReadyUnapproved: number | null;
  total: number;
}

export interface UtilisationRow {
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  clientCount: number;
  authorizedMinutes: number;
  scheduledMinutes: number;
  workedMinutes: number;
  billableMinutes: number;
  reviewMinutes: number;
  approvedMinutes: number;
  remainingMinutes: number;
  lineagesWithoutRate: number;
  /** Administrator only (billing.read); null for everyone else. Values are in cents. */
  billableValueCents: number | null;
  approvedValueCents: number | null;
  unusedValueCents: number | null;
}

export type ViewKind = "ADMINISTRATOR" | "MANAGER" | "SCHEDULER" | "CAREGIVER" | "STAFF";

/** The view label comes from the server-provided role, never from the email. */
export function viewKind(role: string | null): ViewKind {
  switch (role) {
    // Internal role organization_owner is shown to people as Administrator.
    case "organization_owner":
      return "ADMINISTRATOR";
    case "manager":
    case "organization_admin":
      return "MANAGER";
    case "scheduler":
    case "coordinator":
      return "SCHEDULER";
    case "caregiver":
      return "CAREGIVER";
    default:
      return "STAFF";
  }
}

export const VIEW_TITLE: Record<ViewKind, string> = {
  ADMINISTRATOR: "Administrator",
  MANAGER: "Manager",
  SCHEDULER: "Scheduler",
  CAREGIVER: "Caregiver",
  STAFF: "Staff",
};

/** The signed-in person's own name from GET /v1/me (shared cache with the organization provider). */
export function useMyDisplayName(): { displayName: string | null; loading: boolean } {
  const { user } = useAuth();
  const api = useAwsApi();
  const me = useQuery({ queryKey: meQueryKey(user?.id), queryFn: () => fetchMe(api), enabled: !!user, staleTime: 60_000 });
  return { displayName: me.data?.displayName ?? null, loading: me.isLoading };
}

export function useSetMyDisplayName() {
  const { user } = useAuth();
  const api = useAwsApi();
  const queryClient = useQueryClient();
  return async (displayName: string) => {
    await api.post("/v1/me/display-name", { displayName });
    await queryClient.invalidateQueries({ queryKey: meQueryKey(user?.id) });
  };
}

export function useBranding() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["aws-branding", activeOrganizationId],
    queryFn: async () => (await api.get<{ branding: Branding }>("/v1/branding", { organizationId: activeOrganizationId })).branding,
    enabled: !!activeOrganizationId,
    staleTime: 5 * 60_000,
  });
}

export function useAttention() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-attention", activeOrganizationId],
    queryFn: async () => (await api.get<{ summary: AttentionSummary | null }>("/v1/attention", { organizationId: activeOrganizationId })).summary,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
    refetchInterval: 5 * 60_000,
  });
}

export function useUtilisation(monthStart: string) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-utilisation", activeOrganizationId, monthStart],
    queryFn: async () =>
      (await api.get<{ services: UtilisationRow[] }>("/v1/reports/utilisation", { organizationId: activeOrganizationId, monthStart })).services,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
  });
}

/** Minutes as "12.5 h" (hours with one decimal; exact minutes stay on the server). */
export function hoursLabel(minutes: number | null | undefined): string {
  const h = Number(minutes ?? 0) / 60;
  return `${h.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: h % 1 === 0 ? 0 : 1 })} h`;
}

export function moneyLabel(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  return (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export interface DocumentAlerts {
  expired: number;
  expiring: number;
  overdue: number;
  awaitingReview: number;
  rejected: number;
}

export function useDocumentAlerts() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-document-alerts", activeOrganizationId],
    queryFn: async () => (await api.get<{ alerts: DocumentAlerts | null }>("/v1/documents/alerts", { organizationId: activeOrganizationId })).alerts,
    enabled: !!activeOrganizationId && hasPermission("documents.read"),
  });
}
