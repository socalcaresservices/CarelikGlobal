// AWS Service Verification backend (Phase 6). Maps the camelCase API to the
// row shapes the existing screens render, so the screens are unchanged.
import type { AwsApiClient } from "@/lib/aws-api";
import type {
  ActiveVisit,
  AssignedClient,
  AuthorizedService,
  BillingReviewRow,
  CorrectionHistoryReportRow,
  MonthlyServiceSummaryRow,
  ServiceVerificationBackend,
  VisitCorrectionRow,
  VisitReportRow,
  VisitResult,
} from "@/lib/sv-backend";

type Json = Record<string, unknown>;
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function toSnake<T>(row: Json): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [snake(k), v])) as T;
}
const hours = (minutes: unknown) => Number(minutes ?? 0) / 60;
const enc = encodeURIComponent;

export interface AwsMembership {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  organizationTimezone: string;
  role: string;
  permissions: string[];
}

export async function fetchMemberships(api: AwsApiClient): Promise<AwsMembership[]> {
  return (await api.get<{ memberships: AwsMembership[] }>("/v1/me")).memberships;
}

export function createAwsServiceVerificationBackend(
  api: AwsApiClient,
  lookupOrganizationName: (organizationId: string) => string | null,
): ServiceVerificationBackend {
  return {
    kind: "aws",
    async getActiveVisit(organizationId) {
      const { visit } = await api.get<{ visit: Json | null }>("/v1/visits/active", { organizationId });
      if (!visit) return null;
      const row = toSnake<Json>(visit);
      return {
        ...(row as unknown as ActiveVisit),
        max_monthly_hours: hours(row.monthly_authorized_minutes),
        confirmed_minutes_this_month: Number(row.confirmed_minutes_this_month ?? 0),
      };
    },
    async listAssignedClients(organizationId) {
      const { clients } = await api.get<{ clients: Json[] }>("/v1/clients/assigned", { organizationId });
      return clients.map((c) => toSnake<AssignedClient>(c));
    },
    async listAuthorizedServices(organizationId, clientId) {
      const { services } = await api.get<{ services: Json[] }>(`/v1/clients/${enc(clientId)}/services`, { organizationId });
      return services.map((s) => {
        const row = toSnake<Json>(s);
        return {
          ...(row as unknown as AuthorizedService),
          max_monthly_hours: hours(row.monthly_authorized_minutes),
          hours_used_this_month: hours(row.minutes_used_this_month),
          hours_scheduled_this_month: hours(row.minutes_scheduled_this_month),
        };
      });
    },
    async startVisit({ organizationId, clientId, serviceId, idempotencyKey }) {
      const { visitId } = await api.post<{ visitId: string }>("/v1/visits", { organizationId, clientId, serviceId }, { idempotencyKey });
      return visitId;
    },
    async endVisit(visitId) {
      const { visit } = await api.post<{ visit: Json }>(`/v1/visits/${enc(visitId)}/end`, {});
      return { time_in: String(visit.timeIn), time_out: String(visit.timeOut), worked_minutes: Number(visit.workedMinutes) };
    },
    async confirmVisit({ organizationId, visitId, signerRole, method, signatureDataUrl, reason, idempotencyKey }) {
      const { result } = await api.post<{ result: Json }>(
        `/v1/visits/${enc(visitId)}/confirm`,
        {
          organizationId,
          signerRole,
          method,
          reason,
          ...(signatureDataUrl ? { signaturePng: signatureDataUrl } : {}),
        },
        { idempotencyKey },
      );
      return toSnake<VisitResult>(result);
    },
    async listVisits(organizationId, f) {
      const { visits } = await api.get<{ visits: Json[] }>("/v1/visits", {
        organizationId,
        clientId: f.clientId,
        caregiverUserId: f.caregiverUserId,
        serviceId: f.serviceId,
        dateFrom: f.dateFrom,
        dateTo: f.dateTo,
        status: f.status,
      });
      // client_legal_name is not exposed by the AWS API (data minimization).
      return visits.map((v) => ({ ...toSnake<VisitReportRow>(v), client_legal_name: null }));
    },
    async getLetterhead(organizationId) {
      const name = lookupOrganizationName(organizationId) ?? "Organization";
      return {
        legal_name: name,
        display_name: name,
        logo_url: null,
        address_street: null,
        address_city: null,
        address_state: null,
        address_zip: null,
        contact_phone: null,
        contact_email: null,
      };
    },
    async listClientLocations() {
      // Client addresses are not part of the Service Verification API.
      return [];
    },
    async listCorrections(visitId) {
      const { corrections } = await api.get<{ corrections: Json[] }>(`/v1/visits/${enc(visitId)}/corrections`);
      return corrections.map((c) => toSnake<VisitCorrectionRow>(c));
    },
    async correctVisit({ visitId, timeIn, timeOut, reason, idempotencyKey }) {
      await api.post(`/v1/visits/${enc(visitId)}/corrections`, { timeIn, timeOut, reason }, { idempotencyKey });
    },
    async getSignatureDataUrl(visitId) {
      const { pngBase64 } = await api.get<{ pngBase64: string }>(`/v1/visits/${enc(visitId)}/signature`);
      return `data:image/png;base64,${pngBase64}`;
    },
    async listMonthlyServiceSummary(organizationId, clientId, monthStart) {
      const { services } = await api.get<{ services: MonthlyServiceSummaryRow[] }>("/v1/reports/monthly-service-summary", {
        organizationId,
        clientId,
        monthStart,
      });
      return services;
    },
    async listCorrectionHistoryReport(
      organizationId,
      dateFrom,
      dateTo,
      clientId,
      serviceId,
      caregiverUserId,
      correctedByUserId,
      status,
    ) {
      const { corrections } = await api.get<{ corrections: CorrectionHistoryReportRow[] }>("/v1/reports/correction-history", {
        organizationId,
        dateFrom,
        dateTo,
        clientId,
        serviceId,
        caregiverUserId,
        correctedByUserId,
        status,
      });
      return corrections;
    },
    async listBillingReview(organizationId, dateFrom, dateTo) {
      const { visits } = await api.get<{ visits: BillingReviewRow[] }>("/v1/billing-review", { organizationId, dateFrom, dateTo });
      return visits;
    },
  };
}
