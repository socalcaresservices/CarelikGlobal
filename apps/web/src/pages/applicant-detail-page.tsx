import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy } from "lucide-react";
import { Button, Card, StatusBadge, type StatusTone } from "@carelik/ui";
import {
  applicantStatusSchema,
  type ApplicantStatus,
  type DocumentRequestStatus,
  type DocumentRequestSubjectType,
  type EmploymentType
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Record layout: header (name, status) + a details section + weekly
// availability (read-only, same rendering as the caregiver profile's
// own availability display) + the convert-to-caregiver action. No tabs
// here (unlike client/caregiver detail pages) - an application is a
// single flat record, not something with a schedule/credentials/
// incidents history of its own yet.

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface ApplicantDetail {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  email: string;
  phone: string | null;
  alternate_phone: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  status: ApplicantStatus;
  address_street: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  employment_type: EmploymentType | null;
  available_start_date: string | null;
  desired_weekly_hours: number | null;
  min_weekly_hours: number | null;
  max_weekly_hours: number | null;
  min_shift_hours: number | null;
  max_shift_hours: number | null;
  preferred_cities: string[];
  max_travel_minutes: number | null;
  transportation_method: string | null;
  reliable_transportation: boolean | null;
  willing_to_transport_clients: boolean | null;
  valid_drivers_license: boolean | null;
  vehicle_available: boolean | null;
  auto_insurance: boolean | null;
  tb_test_expires_at: string | null;
  cpr_expires_at: string | null;
  background_check_consent: boolean;
  languages: string[];
  notes: string | null;
  hired_caregiver_user_id: string | null;
  created_at: string;
}

interface AvailabilityRow {
  day_of_week: Weekday;
  start_time: string;
  end_time: string;
  preference: "available" | "preferred";
}

interface ApplicantServiceRow {
  service_id: string;
  services: { name: string } | null;
}

interface MemberOption {
  user_id: string;
  display_name: string;
  status: string;
}

function formatAddress(applicant: ApplicantDetail): string {
  const line1 = [applicant.address_street, applicant.address_line2].filter(Boolean).join(", ");
  const line2 = [applicant.address_city, applicant.address_state].filter(Boolean).join(", ");
  const cityStateZip = [line2, applicant.address_zip].filter(Boolean).join(" ");
  return [line1, cityStateZip].filter(Boolean).join(" · ") || "—";
}

const statusTone: Record<ApplicantStatus, StatusTone> = {
  new: "info",
  reviewing: "warning",
  hired: "success",
  rejected: "neutral",
  withdrawn: "neutral"
};

// Document Request Engine (Build 019) - written as a self-contained,
// subject-agnostic card (organizationId/subjectType/subjectId/
// subjectName/subjectEmail as props, not applicant-specific internals)
// so the same component can be dropped onto the caregiver/employee
// detail page in a later build without duplicating this logic.
interface DocumentTypeOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface DocumentRequestRow {
  id: string;
  document_type_name: string;
  status: DocumentRequestStatus;
  uploaded_at: string | null;
  expires_at: string | null;
  rejection_reason: string | null;
  batch_token: string;
  batch_created_at: string;
  file_id: string | null;
  bucket_id: string | null;
  object_path: string | null;
  batch_reminders_sent: number;
  batch_last_reminder_sent_at: string | null;
}

// A staff member can act on an uploaded file once it's landed but hasn't
// been decided on yet. 'pending_review' is reserved for a future
// automated pre-check step (see the document_upload_workflow migration)
// but treated the same as 'uploaded' here since nothing currently
// produces that status.
const REVIEWABLE_STATUSES: DocumentRequestStatus[] = ["uploaded", "pending_review"];

// Same statuses queue_document_reminders() (20260728060000) actually
// sends reminders for - a verified or already-uploaded document isn't
// waiting on the subject anymore, so showing "2 reminders sent" next to
// it would be stale noise, not useful context. Reminder counts live on
// the batch, not the individual request, so every request in the same
// batch shows the same count - accurate (it's genuinely the batch's
// cadence), just not deduplicated across a multi-document batch. That's
// a deliberate simplification for this first pass rather than
// regrouping the whole list by batch.
const REMINDER_ELIGIBLE_STATUSES: DocumentRequestStatus[] = [
  "requested",
  "rejected",
  "replacement_requested",
  "missing"
];

const documentRequestStatusTone: Record<DocumentRequestStatus, StatusTone> = {
  requested: "info",
  uploaded: "warning",
  pending_review: "warning",
  verified: "success",
  rejected: "danger",
  expired: "danger",
  missing: "danger",
  replacement_requested: "warning"
};

function formatDocumentStatus(status: DocumentRequestStatus) {
  return status.replace(/_/g, " ");
}

function DocumentsCard({
  organizationId,
  subjectType,
  subjectId,
  subjectName,
  subjectEmail,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  subjectType: DocumentRequestSubjectType;
  subjectId: string;
  subjectName: string;
  subjectEmail: string | null;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedTypeIds, setSelectedTypeIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const typesQuery = useQuery({
    queryKey: ["document-types", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_types")
        .select("id, name, is_active")
        .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as DocumentTypeOption[];
    },
    enabled: !!organizationId && canManage
  });

  const requestsQuery = useQuery({
    queryKey: ["document-requests-for-subject", organizationId, subjectId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_document_requests_for_subject", {
        target_organization_id: organizationId!,
        target_subject_id: subjectId
      });
      if (error) throw error;
      return (data ?? []) as DocumentRequestRow[];
    },
    enabled: !!organizationId && canRead
  });

  function toggleType(id: string) {
    setSelectedTypeIds((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  async function handleSend() {
    if (!organizationId || selectedTypeIds.length === 0) return;
    setSendError(null);
    setSending(true);
    setGeneratedLink(null);
    setCopied(false);
    try {
      const { data, error } = await supabase.rpc("create_document_request_batch", {
        target_organization_id: organizationId,
        target_subject_type: subjectType,
        target_subject_id: subjectId,
        target_subject_name: subjectName,
        target_subject_email: subjectEmail,
        target_document_type_ids: selectedTypeIds
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.token) {
        setGeneratedLink(`${window.location.origin}/upload/${row.token}`);
      }
      setSelectedTypeIds([]);
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Could not send document request.");
    } finally {
      setSending(false);
    }
  }

  function handleCopyLink() {
    if (!generatedLink) return;
    void navigator.clipboard.writeText(generatedLink).then(() => setCopied(true));
  }

  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function handleView(row: DocumentRequestRow) {
    if (!row.bucket_id || !row.object_path) return;
    setViewError(null);
    setViewingId(row.id);
    try {
      const { data, error } = await supabase.storage.from(row.bucket_id).createSignedUrl(row.object_path, 300);
      if (error) throw error;
      if (data?.signedUrl) {
        window.open(data.signedUrl, "_blank", "noopener,noreferrer");
      }
    } catch (cause) {
      setViewError(cause instanceof Error ? cause.message : "Could not open that file.");
    } finally {
      setViewingId(null);
    }
  }

  async function handleVerify(row: DocumentRequestRow) {
    if (!organizationId) return;
    setDecisionError(null);
    setDecidingId(row.id);
    try {
      const { error } = await supabase.rpc("verify_document_request", {
        target_organization_id: organizationId,
        target_document_request_id: row.id
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : "Could not verify that document.");
    } finally {
      setDecidingId(null);
    }
  }

  async function handleReject(row: DocumentRequestRow) {
    if (!organizationId) return;
    const reason = window.prompt("Why is this document being rejected?");
    if (!reason || !reason.trim()) return;
    setDecisionError(null);
    setDecidingId(row.id);
    try {
      const { error } = await supabase.rpc("reject_document_request", {
        target_organization_id: organizationId,
        target_document_request_id: row.id,
        reason: reason.trim()
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : "Could not reject that document.");
    } finally {
      setDecidingId(null);
    }
  }

  if (!canRead) return null;

  const activeTypes = (typesQuery.data ?? []).filter((type) => type.is_active);
  const requests = requestsQuery.data ?? [];

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Documents</h3>

      {canManage ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-slate-600">Request documents</p>
          {typesQuery.isLoading ? (
            <p className="mt-2 text-sm text-slate-500">Loading document types…</p>
          ) : typesQuery.isError ? (
            <p className="mt-2 text-sm text-red-700">Could not load document types.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {activeTypes.map((type) => (
                <label key={type.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedTypeIds.includes(type.id)}
                    onChange={() => toggleType(type.id)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {type.name}
                </label>
              ))}
            </div>
          )}
          <div className="mt-3">
            <Button disabled={selectedTypeIds.length === 0 || sending} loading={sending} onClick={handleSend}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
          {sendError ? <p className="mt-2 text-sm text-red-700">{sendError}</p> : null}
          {generatedLink ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
              <p className="flex-1 break-all text-xs text-emerald-800">{generatedLink}</p>
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex items-center gap-1 text-xs font-medium text-emerald-800 hover:underline"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        {requestsQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : requestsQuery.isError ? (
          <p className="text-sm text-red-700">Could not load document requests.</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-slate-400">No documents requested yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {requests.map((row) => {
              const isReviewable = canManage && REVIEWABLE_STATUSES.includes(row.status);
              const canView = !!row.bucket_id && !!row.object_path;
              const isBusy = decidingId === row.id || viewingId === row.id;
              return (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-800">{row.document_type_name}</span>
                    <div className="flex items-center gap-2">
                      {canView ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleView(row)}
                          className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline disabled:opacity-60"
                        >
                          {viewingId === row.id ? "Opening…" : "View"}
                        </button>
                      ) : null}
                      {isReviewable ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleVerify(row)}
                            className="text-xs font-medium text-emerald-700 underline-offset-2 hover:underline disabled:opacity-60"
                          >
                            Verify
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleReject(row)}
                            className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:opacity-60"
                          >
                            Reject
                          </button>
                        </>
                      ) : null}
                      <StatusBadge
                        label={formatDocumentStatus(row.status)}
                        tone={documentRequestStatusTone[row.status]}
                      />
                    </div>
                  </div>
                  {row.status === "rejected" && row.rejection_reason ? (
                    <p className="mt-1 text-xs text-red-700">{row.rejection_reason}</p>
                  ) : null}
                  {REMINDER_ELIGIBLE_STATUSES.includes(row.status) && row.batch_reminders_sent > 0 ? (
                    <p className="mt-1 text-xs text-slate-400">
                      {row.batch_reminders_sent} reminder{row.batch_reminders_sent === 1 ? "" : "s"} sent
                      {row.batch_last_reminder_sent_at
                        ? ` · last on ${new Date(row.batch_last_reminder_sent_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {viewError ? <p className="mt-2 text-xs text-red-700">{viewError}</p> : null}
        {decisionError ? <p className="mt-2 text-xs text-red-700">{decisionError}</p> : null}
      </div>
    </Card>
  );
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-Time",
  part_time: "Part-Time",
  per_diem: "Per Diem",
  contractor: "Contractor"
};

// "hired" is only ever set via the convert action below, so it's not a
// choice in this dropdown - picking it manually here would leave
// hired_caregiver_user_id unset, an inconsistent state the convert RPC
// is specifically written to avoid.
const manualStatusOptions = applicantStatusSchema.options.filter((status) => status !== "hired");

export function ApplicantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("applicants.read");
  const canManage = hasPermission("applicants.update");
  const canReadDocuments = hasPermission("documents.read");
  const canManageDocuments = hasPermission("documents.manage");

  const applicantQuery = useQuery({
    queryKey: ["applicant-detail", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("job_applicants").select("*").eq("id", id!).single();
      if (error) throw error;
      return data as ApplicantDetail;
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const availabilityQuery = useQuery({
    queryKey: ["applicant-detail-availability", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_applicant_availability")
        .select("day_of_week, start_time, end_time, preference")
        .eq("applicant_id", id!);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const servicesQuery = useQuery({
    queryKey: ["applicant-detail-services", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_applicant_services")
        .select("service_id, services(name)")
        .eq("applicant_id", id!);
      if (error) throw error;
      // supabase-js can't know service_id -> services is a many-to-one
      // relation without generated Database types, so it infers
      // `services` as an array; cast through unknown rather than
      // widening ApplicantServiceRow to match an inferred type that
      // doesn't reflect the actual (single-row) PostgREST response.
      return (data ?? []) as unknown as ApplicantServiceRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const membersQuery = useQuery({
    queryKey: ["applicant-detail-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as MemberOption[]).filter((member) => member.status === "active");
    },
    enabled: !!activeOrganizationId && canManage
  });

  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  async function handleStatusChange(nextStatus: ApplicantStatus) {
    if (!id) return;
    setStatusError(null);
    setStatusSaving(true);
    try {
      const { error } = await supabase.from("job_applicants").update({ status: nextStatus }).eq("id", id);
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["applicant-detail", activeOrganizationId, id] });
      void queryClient.invalidateQueries({ queryKey: ["applicants", activeOrganizationId] });
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : "Could not update status.");
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleConvert() {
    if (!id || !activeOrganizationId || !selectedMemberId) return;
    setConvertError(null);
    setConverting(true);
    try {
      const { error } = await supabase.rpc("convert_applicant_to_caregiver", {
        target_organization_id: activeOrganizationId,
        target_applicant_id: id,
        target_user_id: selectedMemberId
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["applicant-detail", activeOrganizationId, id] });
      void queryClient.invalidateQueries({ queryKey: ["applicants", activeOrganizationId] });
    } catch (cause) {
      setConvertError(cause instanceof Error ? cause.message : "Could not convert this applicant.");
    } finally {
      setConverting(false);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Applicant</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view job applicants for this organization.
          </p>
        </Card>
      </section>
    );
  }

  if (applicantQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (applicantQuery.isError || !applicantQuery.data) {
    return <p className="text-sm text-red-700">Could not load this applicant.</p>;
  }

  const applicant = applicantQuery.data;

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/applicants" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" />
        All applicants
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">Applicant</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            {applicant.preferred_name || applicant.first_name} {applicant.last_name}
            {applicant.preferred_name ? (
              <span className="ml-2 text-base font-normal text-slate-400">
                ({applicant.first_name} {applicant.last_name})
              </span>
            ) : null}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {applicant.email}
            {applicant.phone ? ` · ${applicant.phone}` : ""}
          </p>
        </div>
        <StatusBadge label={applicant.status} tone={statusTone[applicant.status]} />
      </div>

      <Card>
        <h3 className="font-semibold text-slate-950">Personal information</h3>
        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Date of birth</p>
            <p className="mt-0.5 font-semibold text-slate-950">{applicant.date_of_birth ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Alternate phone</p>
            <p className="mt-0.5 font-semibold text-slate-950">{applicant.alternate_phone ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Emergency contact</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.emergency_contact_name ?? "—"}
              {applicant.emergency_contact_phone ? ` · ${applicant.emergency_contact_phone}` : ""}
            </p>
          </div>
          <div className="sm:col-span-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Home address</p>
            <p className="mt-0.5 font-semibold text-slate-950">{formatAddress(applicant)}</p>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-950">Requirements</h3>
        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">TB test expires</p>
            <p className="mt-0.5 font-semibold text-slate-950">{applicant.tb_test_expires_at ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">CPR expires</p>
            <p className="mt-0.5 font-semibold text-slate-950">{applicant.cpr_expires_at ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Background check</p>
            <p className="mt-0.5">
              <StatusBadge
                label={applicant.background_check_consent ? "Consented" : "Not consented"}
                tone={applicant.background_check_consent ? "success" : "neutral"}
              />
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-950">Services offered</h3>
        {servicesQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : servicesQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load services offered.</p>
        ) : (servicesQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No services selected.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {(servicesQuery.data ?? []).map((row) => (
              <StatusBadge key={row.service_id} label={row.services?.name ?? "Unknown service"} tone="neutral" />
            ))}
          </div>
        )}
      </Card>

      <DocumentsCard
        organizationId={activeOrganizationId}
        subjectType="applicant"
        subjectId={applicant.id}
        subjectName={`${applicant.first_name} ${applicant.last_name}`}
        subjectEmail={applicant.email}
        canRead={canReadDocuments}
        canManage={canManageDocuments}
      />

      {canManage && applicant.status !== "hired" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Status</h3>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {manualStatusOptions.map((option) => (
              <Button
                key={option}
                variant="secondary"
                size="sm"
                disabled={statusSaving || applicant.status === option}
                onClick={() => handleStatusChange(option)}
              >
                Mark {option}
              </Button>
            ))}
          </div>
          {statusError ? <p className="mt-2 text-sm text-red-700">{statusError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <h3 className="font-semibold text-slate-950">Hours and preferences</h3>
        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Employment type</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.employment_type ? EMPLOYMENT_TYPE_LABELS[applicant.employment_type] : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Available start date</p>
            <p className="mt-0.5 font-semibold text-slate-950">{applicant.available_start_date ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Desired weekly hours</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.desired_weekly_hours != null ? `${formatHours(applicant.desired_weekly_hours)}h` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Weekly hour range</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.min_weekly_hours != null || applicant.max_weekly_hours != null
                ? `${applicant.min_weekly_hours != null ? formatHours(applicant.min_weekly_hours) : "?"}–${
                    applicant.max_weekly_hours != null ? formatHours(applicant.max_weekly_hours) : "?"
                  }h`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Shift length range</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.min_shift_hours != null || applicant.max_shift_hours != null
                ? `${applicant.min_shift_hours != null ? formatHours(applicant.min_shift_hours) : "?"}–${
                    applicant.max_shift_hours != null ? formatHours(applicant.max_shift_hours) : "?"
                  }h`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Max travel time</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.max_travel_minutes != null ? `${applicant.max_travel_minutes} min` : "—"}
            </p>
          </div>
          <div className="sm:col-span-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Travel</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {[
                applicant.reliable_transportation ? "Reliable transportation" : null,
                applicant.willing_to_transport_clients ? "Can transport clients" : null,
                applicant.valid_drivers_license ? "Valid driver's license" : null,
                applicant.vehicle_available ? "Vehicle available" : null,
                applicant.auto_insurance ? "Auto insurance" : null
              ]
                .filter((label): label is string => Boolean(label))
                .map((label) => (
                  <StatusBadge key={label} label={label} tone="neutral" />
                ))}
              {![
                applicant.reliable_transportation,
                applicant.willing_to_transport_clients,
                applicant.valid_drivers_license,
                applicant.vehicle_available,
                applicant.auto_insurance
              ].some(Boolean) ? (
                <span className="text-sm text-slate-400">—</span>
              ) : null}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Languages</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.languages.length > 0 ? applicant.languages.join(", ") : "—"}
            </p>
          </div>
        </div>
        {applicant.notes ? (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</p>
            <p className="mt-1 text-sm text-slate-700">{applicant.notes}</p>
          </div>
        ) : null}
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-950">Weekly availability</h3>
        {availabilityQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : availabilityQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load availability.</p>
        ) : (availabilityQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No availability submitted.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {WEEKDAYS.filter((day) => (availabilityQuery.data ?? []).some((row) => row.day_of_week === day)).map(
              (day) => {
                const rows = availabilityQuery
                  .data!.filter((candidate) => candidate.day_of_week === day)
                  .sort((a, b) => a.start_time.localeCompare(b.start_time));
                return (
                  <div key={day} className="flex flex-wrap items-start gap-3 text-sm">
                    <span className="w-24 font-medium text-slate-800">{capitalize(day)}</span>
                    <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1">
                      {rows.map((row, index) => (
                        <span key={`${day}-${index}`} className="flex items-center gap-2 text-slate-600">
                          {row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)}
                          {row.preference === "preferred" ? <StatusBadge label="Preferred" tone="info" /> : null}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        )}
      </Card>

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Convert to caregiver</h3>
          {applicant.hired_caregiver_user_id ? (
            <p className="mt-2 text-sm text-emerald-700">
              Already converted - their availability and desired hours were copied to their caregiver profile.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-500">
                The person must already be an active member of this organization (they accepted a membership
                invitation). This copies their submitted availability and desired hours onto that member&apos;s
                profile - nothing gets re-typed.
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="convert-member" className="block text-xs font-medium text-slate-600">
                    Active member
                  </label>
                  <select
                    id="convert-member"
                    value={selectedMemberId}
                    onChange={(event) => setSelectedMemberId(event.target.value)}
                    className="mt-1 min-w-[16rem] rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">Select a member…</option>
                    {(membersQuery.data ?? []).map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {member.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button disabled={!selectedMemberId || converting} loading={converting} onClick={handleConvert}>
                  {converting ? "Converting…" : "Convert to caregiver"}
                </Button>
              </div>
              {membersQuery.isError ? (
                <p className="mt-2 text-sm text-red-700">Could not load active members.</p>
              ) : null}
              {convertError ? <p className="mt-2 text-sm text-red-700">{convertError}</p> : null}
            </>
          )}
        </Card>
      ) : null}
    </section>
  );
}
