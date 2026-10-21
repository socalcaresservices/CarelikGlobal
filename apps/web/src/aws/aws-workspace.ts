// AWS build: agency workspace data (0020) - the signed-in person's name and
// view, agency branding, NEEDS ATTENTION counts and the utilisation
// overview. Every value is authorized again in PostgreSQL; the UI only
// decides what to show.
import type { HoursFields } from "@/lib/hours-accounting";
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
  /** Print letterhead (0038): entered by the agency's Administrator; null until entered. */
  legalName?: string | null;
  addressStreet?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressZip?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
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
  /** Visits + uncovered shifts + blocking documents + documents to review, each only when the viewer may see it (0033). */
  total: number;
  /** 0033: null when the viewer cannot manage shifts/visits (coverage) or read documents. */
  uncoveredShifts?: number | null;
  documentsBlocking?: number | null;
  documentsToReview?: number | null;
  /** Informational reminder; not part of the total. */
  documentsExpiring?: number | null;
  /** 0036: visits waiting for a requested late confirmation (reminder, not counted). */
  awaitingSignature?: number | null;
  /** 0036: late confirmations received and waiting for review (counted). */
  lateResponsesToReview?: number | null;
  /** 0055: caregivers on a compliance hold. null when the viewer may not see it (never a false zero). */
  complianceHolds?: { holds: number; affectedShifts: number; inProgressVisits: number } | null;
}

export interface UtilisationRow extends HoursFields {
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  clientCount: number;
  authorizedMinutes: number;
  /** 0067: reserved time not yet delivered: shifts ahead plus shifts underway (started, or a visit still open). */
  scheduledMinutes: number;
  /** 0067: all reserved time = scheduled + held for review + needs reconciliation. */
  reservedMinutes?: number;
  /** 0067: reserved while a linked visit is in review. */
  heldReviewMinutes?: number;
  /** 0067: reserved on shifts that ended with no visit record; released only by a person. */
  needsReconciliationMinutes?: number;
  workedMinutes: number;
  billableMinutes: number;
  reviewMinutes: number;
  approvedMinutes: number;
  /** The sum of each authorization's UNUSED time (never negative); the overage is overLimitMinutes. authorized - committed = remaining - overLimit. */
  remainingMinutes: number;
  /** 0057: billable + approved rounding adjustments + reserved. */
  committedMinutes?: number;
  overLimitMinutes?: number;
  nearLimitAuthorizations?: number;
  criticalAuthorizations?: number;
  expiringAuthorizations?: number;
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

/** A count with how many of its items the server says are Critical. Red styling follows `critical`, never the colour of an individual item. */
export interface CountWithCritical { count: number; critical: number }
/**
 * 0080: the badge numbers, each computed by the database from the same rows as the issue list (docs/releases/2026-10-19-review-updates/COUNT_DEFINITIONS.md).
 * A value is null when this person may not see it (never a false zero). The web displays these numbers; it does not recompute them.
 */
export interface AttentionCounts {
  asOf: string;
  needsAttention: CountWithCritical | null;
  needsAction: CountWithCritical;
  scheduling: CountWithCritical | null;
  caregivers: CountWithCritical | null;
  approvals: { exceptions: CountWithCritical | null; readyForApproval: number | null };
}
interface AttentionResponse { summary: AttentionSummary | null; counts?: AttentionCounts | null }

function useAttentionResponse<T>(select: (r: AttentionResponse) => T) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-attention", activeOrganizationId],
    queryFn: async () => api.get<AttentionResponse>("/v1/attention", { organizationId: activeOrganizationId }),
    select,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
    refetchInterval: 5 * 60_000,
  });
}
export const useAttention = () => useAttentionResponse((r) => r.summary);
/** The badge counts; the same request (and refresh) as useAttention. */
export const useAttentionCounts = () => useAttentionResponse((r) => r.counts ?? null);

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

