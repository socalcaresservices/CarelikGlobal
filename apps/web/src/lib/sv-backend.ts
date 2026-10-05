// Backend seam for the Service Verification screens. The screens call these
// methods; the CURRENT production build uses the Supabase implementation, and
// the AWS build (VITE_AUTH_PROVIDER=cognito) provides the AWS API one.
// Business rules (identity, tenant, assignment, authorization, timestamps,
// locking) are enforced by the backend in both cases, never here.
import { createContext } from "react";
import type {
  ServiceVisitStatus,
  VisitAuthorizationStatus,
  VisitSignerRole,
} from "@/lib/service-verification";

export interface AssignedClient {
  client_id: string;
  client_code: string;
  next_scheduled_starts_at: string | null;
  next_scheduled_ends_at: string | null;
  active_service_count: number;
  /** Service of that same shift (AWS 0017). Absent on backends without it. */
  next_scheduled_service_id?: string | null;
}

export interface AuthorizedService {
  service_id: string;
  service_code: string;
  service_name: string;
  service_color: string | null;
  authorization_id: string;
  max_monthly_hours: number;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
}

export interface ActiveVisit {
  visit_id: string;
  visit_number: string | null;
  client_code: string;
  service_code: string;
  service_name: string;
  scheduled_starts_at: string | null;
  scheduled_ends_at: string | null;
  time_in: string;
  time_out: string | null;
  worked_minutes: number | null;
  visit_status: "draft" | "awaiting_signature";
  max_monthly_hours: number;
  confirmed_minutes_this_month: number;
  // Time Out entered by a manager closing a missed clock-out (0015).
  time_out_entered_by_manager?: boolean | null;
}

export interface EndedVisitTimes {
  time_in: string;
  time_out: string;
  worked_minutes: number;
}

export interface VisitResult {
  status: ServiceVisitStatus;
  authorization_status: VisitAuthorizationStatus;
  worked_minutes: number;
  billable_minutes: number;
  month_to_date_minutes: number;
  remaining_minutes: number;
}

export type ConfirmationMethod = "draw" | "assisted_mark" | "unable_to_confirm";

export interface ConfirmVisitInput {
  organizationId: string;
  visitId: string;
  signerRole: VisitSignerRole;
  method: ConfirmationMethod;
  /** PNG data URL for draw/assisted_mark; null otherwise. */
  signatureDataUrl: string | null;
  reason: string | null;
  /** Same key for retries of the same submission (server deduplicates). */
  idempotencyKey: string;
}

export interface VisitReportRow {
  id: string;
  visit_number: string | null;
  client_id: string;
  client_code: string;
  client_legal_name: string | null;
  caregiver_user_id: string;
  caregiver_name: string;
  service_id: string;
  service_name: string;
  service_date: string;
  time_in: string;
  time_out: string | null;
  worked_minutes: number | null;
  verified_minutes: number | null;
  billable_minutes: number | null;
  status: ServiceVisitStatus;
  authorization_status: VisitAuthorizationStatus | null;
  signed_at: string | null;
  original_visit_id: string | null;
  is_corrected: boolean;
  month_to_date_before_minutes: number | null;
  month_to_date_after_minutes: number | null;
  remaining_minutes: number | null;
  // The linked shift's window (0013); null when the visit has no scheduled shift.
  scheduled_starts_at?: string | null;
  scheduled_ends_at?: string | null;
  time_out_entered_by_manager?: boolean | null;
  /** 0030 (AWS): the caregiver's scheduling arrangement; "flexible" visits need no shift. */
  caregiver_scheduling_mode?: string | null;
}

export interface VisitCorrectionRow {
  id: string;
  corrected_by_name: string;
  reason: string;
  before_snapshot: { timeIn: string; timeOut: string; workedMinutes: number; billableMinutes: number };
  after_snapshot: { timeIn: string; timeOut: string; workedMinutes: number; billableMinutes: number };
  created_at: string;
}

export interface OrgLetterhead {
  legal_name: string;
  display_name: string;
  logo_url: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  contact_phone: string | null;
  contact_email: string | null;
}

export interface ClientLocation {
  id: string;
  address_city: string | null;
  address_state: string | null;
}

export interface VisitReportFilters {
  clientId: string | null;
  caregiverUserId: string | null;
  serviceId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  status: string | null;
}

export interface CorrectVisitInput {
  visitId: string;
  timeIn: string;
  timeOut: string;
  reason: string;
  idempotencyKey: string;
}

export interface CloseMissedVisitInput {
  visitId: string;
  timeOut: string;
  reason: string;
  idempotencyKey: string;
}

export interface MonthlyServiceSummaryRow {
  clientId: string;
  clientCode: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  authorizationLineageId: string;
  authorizationPeriodStart: string;
  authorizationPeriodEnd: string;
  authorizedMinutes: number;
  workedMinutes: number;
  verifiedMinutes: number;
  billableMinutes: number;
  // Authorized - billable - scheduled (reserved by assigned Care Requests), as the assignment cap counts it (0016).
  remainingMinutes: number;
  reviewMinutes: number;
  visitCount: number;
  // Time held by assigned Care Request shifts not yet signed (0016).
  reservedMinutes?: number;
}

export interface CorrectionHistoryReportRow {
  correctionId: string;
  visitNumber: string | null;
  clientId: string;
  clientCode: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  serviceDate: string;
  caregiverUserId: string | null;
  caregiverName: string;
  correctedByUserId: string;
  correctedByName: string;
  correctedVisitStatus: ServiceVisitStatus;
  reason: string;
  beforeSnapshot: { timeIn: string; timeOut: string; workedMinutes: number; billableMinutes: number };
  afterSnapshot: { timeIn: string; timeOut: string; workedMinutes: number; billableMinutes: number };
  createdAt: string;
}

export interface BillingReviewRow {
  visitId: string;
  visitNumber: string | null;
  serviceCode: string;
  serviceDate: string;
  workedMinutes: number | null;
  verifiedMinutes: number | null;
  billableMinutes: number | null;
  visitStatus: ServiceVisitStatus;
  authorizationStatus: VisitAuthorizationStatus | null;
  authorizationVersion: number | null;
  confirmationMethod: string | null;
  hasSignatureEvidence: boolean;
  isCorrection: boolean;
  reviewState: string;
  /** AWS (0030); absent on older back ends. clientName is null without clients.names.read. */
  clientCode?: string | null;
  clientName?: string | null;
  caregiverName?: string | null;
  serviceName?: string | null;
  timeIn?: string | null;
  timeOut?: string | null;
  caregiverSchedulingMode?: "fixed" | "flexible" | null;
  scheduledShiftId?: string | null;
}

/** A human billing approval. rateCents/amountCents are null unless the caller holds billing.read (owner). */
export interface BillingApprovalRow {
  billingApprovalId: string;
  visitId: string;
  visitNumber: string | null;
  serviceDate: string;
  approvedMinutes: number;
  billableMinutesAtApproval: number;
  approvedAt: string;
  approvedByName: string;
  notes: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  rateCents: number | null;
  amountCents: number | null;
}

export interface ServiceVerificationBackend {
  readonly kind: "supabase" | "aws";
  getActiveVisit(organizationId: string): Promise<ActiveVisit | null>;
  listAssignedClients(organizationId: string): Promise<AssignedClient[]>;
  listAuthorizedServices(organizationId: string, clientId: string): Promise<AuthorizedService[]>;
  startVisit(input: { organizationId: string; clientId: string; serviceId: string; idempotencyKey: string }): Promise<string>;
  endVisit(visitId: string): Promise<EndedVisitTimes>;
  confirmVisit(input: ConfirmVisitInput): Promise<VisitResult>;
  listVisits(organizationId: string, filters: VisitReportFilters): Promise<VisitReportRow[]>;
  getLetterhead(organizationId: string): Promise<OrgLetterhead>;
  listClientLocations(organizationId: string): Promise<ClientLocation[]>;
  listCorrections(visitId: string): Promise<VisitCorrectionRow[]>;
  correctVisit(input: CorrectVisitInput): Promise<void>;
  /** Manager close-out of a missed clock-out: enters the actual Time Out. */
  closeMissedVisit(input: CloseMissedVisitInput): Promise<void>;
  /** AWS only: the locked signature as a PNG data URL (permission-checked, audited). */
  getSignatureDataUrl?(visitId: string): Promise<string>;
  /** AWS reporting: one row per client + service + authorization lineage for a month. */
  listMonthlyServiceSummary?(organizationId: string, clientId: string | null, monthStart: string): Promise<MonthlyServiceSummaryRow[]>;
  /** AWS reporting: organization correction audit report. */
  listCorrectionHistoryReport?(
    organizationId: string,
    dateFrom: string | null,
    dateTo: string | null,
    clientId: string | null,
    serviceId: string | null,
    caregiverUserId: string | null,
    correctedByUserId: string | null,
    status: string | null,
  ): Promise<CorrectionHistoryReportRow[]>;
  /** AWS only: billing-review data (read-only; no approval or submission). */
  listBillingReview?(organizationId: string, dateFrom: string, dateTo: string): Promise<BillingReviewRow[]>;
  /** AWS only: human billing approvals (approval is not submission). */
  listBillingApprovals?(organizationId: string, dateFrom: string, dateTo: string): Promise<BillingApprovalRow[]>;
  approveVisitForBilling?(input: { visitId: string; approvedMinutes: number; notes: string | null; idempotencyKey: string }): Promise<string>;
  voidBillingApproval?(input: { billingApprovalId: string; reason: string; idempotencyKey: string }): Promise<void>;
}

export const ServiceVerificationBackendContext = createContext<ServiceVerificationBackend | null>(null);

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
