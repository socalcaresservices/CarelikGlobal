// CURRENT production Service Verification backend: Supabase RPCs + Storage.
// The calls are the ones the screens made before the backend seam existed;
// behavior is unchanged (idempotency keys are not used by these RPCs).
import { useContext } from "react";
import { supabase } from "@/lib/supabase";
import {
  ServiceVerificationBackendContext,
  type ActiveVisit,
  type AssignedClient,
  type AuthorizedService,
  type ClientLocation,
  type EndedVisitTimes,
  type OrgLetterhead,
  type ScheduledShift,
  type ServiceVerificationBackend,
  type VisitCorrectionRow,
  type VisitReportRow,
  type VisitResult,
} from "@/lib/sv-backend";

// PostgREST PGRST202 / Postgres 42883: the function (or this argument list) does not exist.
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

export const supabaseServiceVerificationBackend: ServiceVerificationBackend = {
  kind: "supabase",
  async getActiveVisit(organizationId) {
    const { data, error } = await supabase.rpc("get_active_service_visit_v3", { target_organization_id: organizationId });
    if (error) throw error;
    return ((data ?? [])[0] ?? null) as ActiveVisit | null;
  },
  async listAssignedClients(organizationId) {
    const { data, error } = await supabase.rpc("list_assigned_visit_clients", { target_organization_id: organizationId });
    if (error) throw error;
    return (data ?? []) as AssignedClient[];
  },
  async listAuthorizedServices(organizationId, clientId) {
    const { data, error } = await supabase.rpc("list_authorized_services_for_client", {
      target_organization_id: organizationId,
      target_client_id: clientId,
    });
    if (error) throw error;
    return (data ?? []) as AuthorizedService[];
  },
  async startVisit({ organizationId, clientId, serviceId, scheduledShiftId }) {
    // scheduled_shift_id exists only after 20260828_visit_verification_redesign is applied.
    // Send it only when a shift was chosen so the call also matches the older signature
    // (without it) that production had when this was written.
    const { data, error } = await supabase.rpc("start_ad_hoc_service_visit", {
      target_organization_id: organizationId,
      target_client_id: clientId,
      target_service_id: serviceId,
      ...(scheduledShiftId ? { scheduled_shift_id: scheduledShiftId } : {}),
      visit_task_categories: [],
      visit_service_notes: null,
    });
    if (error) throw error;
    return typeof data === "string" ? data : "";
  },
  async listScheduledShifts(organizationId, clientId) {
    const { data, error } = await supabase.rpc("list_scheduled_shifts_for_visit", {
      target_organization_id: organizationId,
      target_client_id: clientId,
    });
    // Database without the redesign migration: no shift picker; the server links the shift itself.
    if (isMissingFunction(error)) return [];
    if (error) throw error;
    return (data ?? []) as ScheduledShift[];
  },
  async endVisit(visitId) {
    const { data, error } = await supabase.rpc("end_service_visit", {
      target_visit_id: visitId,
      visit_task_categories: [],
      visit_service_notes: null,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as EndedVisitTimes;
  },
  async confirmVisit({ organizationId, visitId, signerRole, method, signatureDataUrl, reason }) {
    let storagePath: string | null = null;
    if (signatureDataUrl) {
      const response = await fetch(signatureDataUrl);
      const blob = await response.blob();
      storagePath = `${organizationId}/${visitId}/client-signature.png`;
      const { error: uploadError } = await supabase.storage
        .from("visit-signatures")
        .upload(storagePath, blob, { contentType: "image/png", upsert: true });
      if (uploadError) throw uploadError;
    }
    const { data, error } = await supabase.rpc("confirm_service_visit", {
      target_visit_id: visitId,
      signer_role: signerRole,
      confirmation_method: method,
      signature_storage_path: storagePath,
      typed_signer_name: null,
      signer_relationship: null,
      confirmation_reason: reason,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as VisitResult;
  },
  async listVisits(organizationId, f) {
    const { data, error } = await supabase.rpc("list_service_visits", {
      target_organization_id: organizationId,
      filter_client_id: f.clientId,
      filter_caregiver_user_id: f.caregiverUserId,
      filter_service_id: f.serviceId,
      filter_date_from: f.dateFrom,
      filter_date_to: f.dateTo,
      filter_status: f.status,
    });
    if (error) throw error;
    return (data ?? []) as VisitReportRow[];
  },
  async getLetterhead(organizationId) {
    const { data, error } = await supabase
      .from("organizations")
      .select("legal_name, display_name, logo_url, address_street, address_city, address_state, address_zip, contact_phone, contact_email")
      .eq("id", organizationId)
      .single();
    if (error) throw error;
    return data as OrgLetterhead;
  },
  async listClientLocations(organizationId) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, address_city, address_state")
      .eq("organization_id", organizationId)
      .is("deleted_at", null);
    if (error) throw error;
    return (data ?? []) as ClientLocation[];
  },
  async listCorrections(visitId) {
    const { data, error } = await supabase.rpc("list_visit_corrections", { target_visit_id: visitId });
    if (error) throw error;
    return (data ?? []) as VisitCorrectionRow[];
  },
  async correctVisit({ visitId, timeIn, timeOut, reason }) {
    const { error } = await supabase.rpc("correct_service_visit", {
      target_visit_id: visitId,
      new_time_in: timeIn,
      new_time_out: timeOut,
      reason,
    });
    if (error) throw error;
  },
  async closeMissedVisit({ visitId, timeOut, reason }) {
    const { error } = await supabase.rpc("close_missed_service_visit", {
      target_visit_id: visitId,
      actual_time_out: timeOut,
      reason,
    });
    if (error) throw error;
  },
};

/** The backend for the current screen: AWS when provided, otherwise the current Supabase one. */
export function useServiceVerificationBackend(): ServiceVerificationBackend {
  return useContext(ServiceVerificationBackendContext) ?? supabaseServiceVerificationBackend;
}
