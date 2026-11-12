// AWS Service Verification backend (Phase 6). Maps the camelCase API to the
// row shapes the existing screens render, so the screens are unchanged.
import type { AwsApiClient } from "@/lib/aws-api";
import type { Branding } from "@/aws/aws-workspace";
import type {
  ActiveVisit,
  AssignedClient,
  AuthorizedService,
  BillingApprovalRow,
  BillingReviewRow,
  CorrectionHistoryReportRow,
  MonthlyApprovalSummaryRow,
  MonthlyServiceSummaryRow,
  MissingScheduledVisit,
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
/** A server minutes figure that may be missing (an older server): null, never a false zero. */
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const enc = encodeURIComponent;

export interface AwsMembership {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  organizationTimezone: string;
  role: string;
  permissions: string[];
}

/** A staff invitation waiting for this person to accept it (0087). It grants nothing until accepted. */
export interface AwsPendingInvitation {
  organizationId: string;
  organizationName: string;
  role: string;
}

export interface AwsMe {
  memberships: AwsMembership[];
  /** Invitations to other agencies awaiting this person's acceptance; empty on a server that does not have them. */
  pendingInvitations: AwsPendingInvitation[];
  /** The signed-in person's own name; null when they have not set one (never invented). */
  displayName: string | null;
}

export async function fetchMe(api: AwsApiClient): Promise<AwsMe> {
  const me = await api.get<{ memberships: AwsMembership[]; pendingInvitations?: AwsPendingInvitation[]; profile?: { displayName: string | null } }>("/v1/me");
  return { memberships: me.memberships, pendingInvitations: me.pendingInvitations ?? [], displayName: me.profile?.displayName ?? null };
}

export function createAwsServiceVerificationBackend(
  api: AwsApiClient,
  lookupOrganizationName: (organizationId: string) => string | null,
): ServiceVerificationBackend {
  const duplicateClients = new Set<string>();
  async function clientNames(organizationId: string): Promise<Map<string, string>> {
    const { clients } = await api.get<{ clients: Array<{ clientId: string; legalFirstName: string | null; legalLastName: string | null; duplicateName?: boolean }> }>(
      "/v1/clients/directory",
      { organizationId },
    );
    duplicateClients.clear();
    for (const c of clients) if (c.duplicateName) duplicateClients.add(c.clientId);
    return new Map(
      clients
        .filter((c) => c.legalFirstName && c.legalLastName)
        .map((c) => [c.clientId, `${c.legalFirstName} ${c.legalLastName}`]),
    );
  }
  return {
    kind: "aws",
    wave1: true,
    async getActiveVisit(organizationId) {
      const { visit } = await api.get<{ visit: Json | null }>("/v1/visits/active", { organizationId });
      if (!visit) return null;
      const row = toSnake<Json>(visit);
      return {
        ...(row as unknown as ActiveVisit),
        max_monthly_hours: hours(row.monthly_authorized_minutes),
        confirmed_minutes_this_month: Number(row.confirmed_minutes_this_month ?? 0),
        left_to_record_minutes: row.left_to_record_minutes === null || row.left_to_record_minutes === undefined ? null : Number(row.left_to_record_minutes),
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
          left_to_record_minutes: num(row.left_to_record_minutes),
          hours_left_minutes: num(row.hours_left_minutes),
          office_pending_minutes: num(row.office_pending_minutes),
          office_reserved_minutes: num(row.office_reserved_minutes),
        };
      });
    },
    async startVisit({ organizationId, clientId, serviceId, unscheduledReason, idempotencyKey }) {
      const { visitId } = await api.post<{ visitId: string }>(
        "/v1/visits",
        { organizationId, clientId, serviceId, ...(unscheduledReason ? { unscheduledReason } : {}) },
        { idempotencyKey },
      );
      return visitId;
    },
    async endVisit(visitId) {
      const { visit } = await api.post<{ visit: Json }>(`/v1/visits/${enc(visitId)}/end`, {});
      return { time_in: String(visit.timeIn), time_out: String(visit.timeOut), worked_minutes: Number(visit.workedMinutes) };
    },
    async confirmVisit({ organizationId, visitId, signerRole, method, signatureDataUrl, reason, typedSignerName, attested, idempotencyKey }) {
      const { result } = await api.post<{ result: Json }>(
        `/v1/visits/${enc(visitId)}/confirm`,
        {
          organizationId,
          signerRole,
          method,
          reason,
          ...(typedSignerName ? { typedSignerName } : {}),
          ...(attested ? { attested: true } : {}),
          ...(signatureDataUrl ? { signaturePng: signatureDataUrl } : {}),
        },
        { idempotencyKey },
      );
      const { outcome, ...rest } = result as Json & { outcome?: Json };
      return { ...toSnake<VisitResult>(rest), ...(outcome ? { outcome: toSnake<NonNullable<VisitResult["outcome"]>>(outcome) } : {}) };
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
      // Legal names come only from the restricted directory: the server returns
      // them to office roles (clients.names.read) and null to everyone else.
      const names = await clientNames(organizationId);
      return visits.map((v) => {
        const row = toSnake<VisitReportRow>(v);
        return { ...row, client_legal_name: names.get(row.client_id) ?? null, client_name_duplicate: duplicateClients.has(row.client_id) };
      });
    },
    async getLetterhead(organizationId) {
      const { branding } = await api.get<{ branding: Branding }>("/v1/branding", { organizationId });
      const name = branding.displayName ?? lookupOrganizationName(organizationId) ?? "Organization";
      let logoUrl: string | null = null;
      if (branding.logoSha256) {
        const logo = await api.get<{ contentType: string; fileBase64: string }>("/v1/branding/logo", { organizationId });
        logoUrl = `data:${logo.contentType};base64,${logo.fileBase64}`;
      }
      return {
        // Only what the agency's Administrator entered (Settings > Branding); nothing is assumed.
        legal_name: branding.legalName ?? name,
        display_name: name,
        logo_url: logoUrl,
        address_street: branding.addressStreet ?? null,
        address_city: branding.addressCity ?? null,
        address_state: branding.addressState ?? null,
        address_zip: branding.addressZip ?? null,
        contact_phone: branding.contactPhone ?? null,
        contact_email: branding.contactEmail ?? null,
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
    async listMissingScheduledVisits(organizationId, filters) {
      const result = await api.get<{ missingVisits: MissingScheduledVisit[] }>("/v1/reports/missing-visits", {
        organizationId, from: filters.dateFrom, to: filters.dateTo, clientId: filters.clientId,
        serviceId: filters.serviceId, caregiverUserId: filters.caregiverUserId,
      });
      return result.missingVisits;
    },
    async listMissingVisitReasonLabels(organizationId) {
      return (await api.get<{ reasonLabels: { label: string; visits: number }[] }>("/v1/reports/missing-visits", { organizationId, reasonLabels: "true" })).reasonLabels;
    },
    async recordMissingScheduledVisit({ organizationId, shiftId, timeIn, timeOut, reason, reasonLabel, idempotencyKey }) {
      const result = await api.post<{ visitId: string }>(`/v1/shifts/${enc(shiftId)}/missing-visit`, { organizationId, timeIn, timeOut, reason, reasonLabel }, { idempotencyKey });
      return result.visitId;
    },
    async closeMissedVisit({ visitId, timeOut, reason, idempotencyKey }) {
      await api.post(`/v1/visits/${enc(visitId)}/close`, { timeOut, reason }, { idempotencyKey });
    },
    async markNoServiceDelivered({ visitId, reason, idempotencyKey }) {
      await api.post(`/v1/visits/${enc(visitId)}/close`, { outcome: "no_service", reason }, { idempotencyKey });
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
      const names = await clientNames(organizationId);
      return services.map((row) => ({ ...row, clientName: names.get(row.clientId) ?? null, clientNameDuplicate: duplicateClients.has(row.clientId) }));
    },
    async listMonthlyApprovalSummary(organizationId, clientId, monthStart) {
      const { lineages } = await api.get<{ lineages: MonthlyApprovalSummaryRow[] }>("/v1/reports/monthly-approval-summary", {
        organizationId,
        clientId,
        monthStart,
      });
      return lineages;
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
      const names = await clientNames(organizationId);
      return corrections.map((row) => ({ ...row, clientName: names.get(row.clientId) ?? null, clientNameDuplicate: duplicateClients.has(row.clientId) }));
    },
    async listBillingReview(organizationId, dateFrom, dateTo) {
      const { visits } = await api.get<{ visits: BillingReviewRow[] }>("/v1/billing-review", { organizationId, dateFrom, dateTo });
      return visits;
    },
    async listBillingApprovals(organizationId, dateFrom, dateTo) {
      const { approvals } = await api.get<{ approvals: BillingApprovalRow[] }>("/v1/billing-approvals", { organizationId, dateFrom, dateTo });
      return approvals;
    },
    async approveVisitForBilling({ visitId, approvedMinutes, notes, idempotencyKey }) {
      const { billingApprovalId } = await api.post<{ billingApprovalId: string }>(
        `/v1/visits/${enc(visitId)}/billing-approval`,
        { approvedMinutes, notes },
        { idempotencyKey },
      );
      return billingApprovalId;
    },
    async voidBillingApproval({ billingApprovalId, reason, idempotencyKey }) {
      await api.post(`/v1/billing-approvals/${enc(billingApprovalId)}/void`, { reason }, { idempotencyKey });
    },
  };
}
