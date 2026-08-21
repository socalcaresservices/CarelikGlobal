import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clipboard, Link2, X } from "lucide-react";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { POSITION_OPTIONS } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { DocumentsCard } from "@/components/documents-card";

const CANDIDATE_SOURCES = ["indeed", "ziprecruiter", "referral", "agency_website", "manual", "other"] as const;

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
type Stage =
  | "imported" | "application_needed" | "application_received" | "screening" | "interview"
  | "conditional_offer" | "hired_onboarding_required" | "onboarding_scheduled" | "onboarding"
  | "compliance_pending" | "ready_to_work" | "care_team" | "on_hold" | "rejected" | "withdrawn";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface CandidateRow {
  id: string; candidate_code: string; first_name: string; last_name: string; preferred_name: string | null; email: string | null; phone: string | null;
  address_street: string | null; address_line2: string | null; address_city: string | null; address_state: string | null; address_zip: string | null;
  pipeline_stage: Stage; source: string; position_applied_for: string | null; applied_at: string | null;
  employment_type: string | null; available_start_date: string | null; desired_weekly_hours: number | null;
  min_shift_hours: number | null; max_shift_hours: number | null; max_travel_minutes: number | null;
  transportation_method: string | null; reliable_transportation: boolean | null; valid_drivers_license: boolean | null;
  auto_insurance: boolean | null; languages: string[]; notes: string | null;
}
interface StageOption { stage_key: Stage; display_label: string; is_active: boolean; }
interface AvailabilityRow { id: string; day_of_week: Weekday; start_time: string; end_time: string; preference: "available" | "preferred"; }
interface CredentialRow { id: string; credential_type: string; issue_date: string | null; expiration_date: string | null; does_not_expire: boolean; issuing_organization: string | null; credential_number: string | null; verification_status: "unverified" | "verified" | "rejected"; }
interface RequirementRow { name: string; is_required: boolean; is_active: boolean; }
interface StageHistoryRow { id: string; to_stage: string; note: string | null; changed_at: string; }
interface OnboardingRow { status: string; scheduled_at: string | null; method: string | null; location: string | null; instructions: string | null; notes: string | null; background_check_status: string; compliance_status: string; completed_at: string | null; }
interface PortalTokenRow { id: string; expires_at: string; created_at: string; revoked_at: string | null; last_used_at: string | null; }

function title(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatAddress(candidate: CandidateRow) {
  const street = [candidate.address_street, candidate.address_line2].filter(Boolean).join(", ");
  const locality = [candidate.address_city, candidate.address_state, candidate.address_zip].filter(Boolean).join(" ");
  return [street, locality].filter(Boolean).join(" · ") || "—";
}

export function CandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("applicants.read");
  const canManage = hasPermission("applicants.update");
  const canTransfer = canManage && hasPermission("membership.update");
  const canReadDocuments = hasPermission("documents.read");
  const canManageDocuments = hasPermission("documents.manage");

  const candidateQuery = useQuery({
    queryKey: ["candidate-detail-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("job_applicants").select("*").eq("organization_id", activeOrganizationId!).eq("id", id!).single();
      if (error) throw error;
      return data as CandidateRow;
    }, enabled: !!activeOrganizationId && !!id && canRead
  });

  const stagesQuery = useQuery({
    queryKey: ["candidate-stage-options", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_candidate_pipeline_stages", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return ((data ?? []) as StageOption[]).filter((row) => row.is_active);
    }, enabled: !!activeOrganizationId && canRead
  });

  const availabilityQuery = useQuery({
    queryKey: ["candidate-availability-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("job_applicant_availability").select("id, day_of_week, start_time, end_time, preference").eq("organization_id", activeOrganizationId!).eq("applicant_id", id!);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    }, enabled: !!activeOrganizationId && !!id && canRead
  });

  const credentialsQuery = useQuery({
    queryKey: ["candidate-credentials-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("candidate_credentials").select("id, credential_type, issue_date, expiration_date, does_not_expire, issuing_organization, credential_number, verification_status").eq("organization_id", activeOrganizationId!).eq("applicant_id", id!).is("deleted_at", null).order("credential_type");
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    }, enabled: !!activeOrganizationId && !!id && canRead
  });

  const requirementsQuery = useQuery({
    queryKey: ["candidate-requirements-v1", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_credential_types", { target_organization_id: activeOrganizationId!, target_applies_to: "candidate" });
      if (error) throw error;
      return ((data ?? []) as RequirementRow[]).filter((row) => row.is_active && row.is_required);
    }, enabled: !!activeOrganizationId && canRead
  });

  const onboardingQuery = useQuery({
    queryKey: ["candidate-onboarding-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("candidate_onboarding").select("status, scheduled_at, method, location, instructions, notes, background_check_status, compliance_status, completed_at").eq("organization_id", activeOrganizationId!).eq("applicant_id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as OnboardingRow | null;
    }, enabled: !!activeOrganizationId && !!id && canRead
  });

  const historyQuery = useQuery({
    queryKey: ["candidate-stage-history-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("candidate_stage_history").select("id, to_stage, note, changed_at").eq("organization_id", activeOrganizationId!).eq("applicant_id", id!).order("changed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as StageHistoryRow[];
    }, enabled: !!activeOrganizationId && !!id && canRead
  });

  const portalTokensQuery = useQuery({
    queryKey: ["candidate-portal-links", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("candidate_portal_tokens").select("id, expires_at, created_at, revoked_at, last_used_at").eq("organization_id", activeOrganizationId!).eq("applicant_id", id!).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PortalTokenRow[];
    }, enabled: !!activeOrganizationId && !!id && canManage
  });

  const [candidateIdCopied, setCandidateIdCopied] = useState(false);
  async function copyCandidateId(candidateCode: string) {
    try {
      await navigator.clipboard.writeText(candidateCode);
      setCandidateIdCopied(true);
      window.setTimeout(() => setCandidateIdCopied(false), 1800);
    } catch {
      // Clipboard access can be denied by the browser - the code is still shown on screen.
    }
  }

  const [editingCandidate, setEditingCandidate] = useState(false);
  const [candidateForm, setCandidateForm] = useState({
    first_name: "", last_name: "", preferred_name: "", email: "", phone: "",
    position: "" as (typeof POSITION_OPTIONS)[number] | "", positionOther: "",
    source: "manual" as (typeof CANDIDATE_SOURCES)[number],
    desired_weekly_hours: "", address_street: "", address_city: "", address_state: "", address_zip: "",
    notes: ""
  });
  const [candidateSaving, setCandidateSaving] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateSuccess, setCandidateSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!candidateQuery.data) return;
    const data = candidateQuery.data;
    const existingPosition = data.position_applied_for ?? "";
    const knownPosition = existingPosition && (POSITION_OPTIONS as readonly string[]).includes(existingPosition);
    setCandidateForm({
      first_name: data.first_name,
      last_name: data.last_name,
      preferred_name: data.preferred_name ?? "",
      email: data.email ?? "",
      phone: data.phone ?? "",
      position: knownPosition ? (existingPosition as (typeof POSITION_OPTIONS)[number]) : existingPosition ? "Other" : "",
      positionOther: knownPosition ? "" : existingPosition,
      source: (CANDIDATE_SOURCES as readonly string[]).includes(data.source) ? (data.source as (typeof CANDIDATE_SOURCES)[number]) : "other",
      desired_weekly_hours: data.desired_weekly_hours?.toString() ?? "",
      address_street: data.address_street ?? "",
      address_city: data.address_city ?? "",
      address_state: data.address_state ?? "",
      address_zip: data.address_zip ?? "",
      notes: data.notes ?? ""
    });
  }, [candidateQuery.data]);

  useEffect(() => {
    if (!candidateSuccess) return;
    const timer = window.setTimeout(() => setCandidateSuccess(null), 5000);
    return () => window.clearTimeout(timer);
  }, [candidateSuccess]);

  const candidatePositionValue = candidateForm.position === "Other" ? candidateForm.positionOther.trim() : candidateForm.position;
  const candidateCanSave =
    !!candidateForm.first_name.trim() &&
    !!candidateForm.last_name.trim() &&
    (!!candidateForm.email.trim() || !!candidateForm.phone.trim());

  async function saveCandidate() {
    if (!activeOrganizationId || !id || !candidateCanSave || candidateSaving) return;
    setCandidateSaving(true);
    setCandidateError(null);
    setCandidateSuccess(null);
    try {
      const { error } = await supabase
        .from("job_applicants")
        .update({
          first_name: candidateForm.first_name.trim(),
          last_name: candidateForm.last_name.trim(),
          preferred_name: candidateForm.preferred_name.trim() || null,
          email: candidateForm.email.trim() || null,
          phone: candidateForm.phone.trim() || null,
          position_applied_for: candidatePositionValue || null,
          source: candidateForm.source,
          desired_weekly_hours: candidateForm.desired_weekly_hours ? Number(candidateForm.desired_weekly_hours) : null,
          address_street: candidateForm.address_street.trim() || null,
          address_city: candidateForm.address_city.trim() || null,
          address_state: candidateForm.address_state.trim() || null,
          address_zip: candidateForm.address_zip.trim() || null,
          notes: candidateForm.notes.trim() || null
        })
        .eq("organization_id", activeOrganizationId)
        .eq("id", id);
      if (error) throw error;
      setCandidateSuccess("Candidate updated.");
      setEditingCandidate(false);
      void queryClient.invalidateQueries({ queryKey: ["candidate-detail-v1", activeOrganizationId, id] });
      void queryClient.invalidateQueries({ queryKey: ["candidates", activeOrganizationId] });
    } catch (cause) {
      setCandidateError(cause instanceof Error ? cause.message : "Could not update this candidate.");
    } finally {
      setCandidateSaving(false);
    }
  }

  const [stageNote, setStageNote] = useState("");
  const [onboarding, setOnboarding] = useState<OnboardingRow>({ status: "not_scheduled", scheduled_at: null, method: null, location: null, instructions: null, notes: null, background_check_status: "not_started", compliance_status: "pending", completed_at: null });
  const [portalTtlHours, setPortalTtlHours] = useState("168");
  const [newPortalLink, setNewPortalLink] = useState<string | null>(null);

  useEffect(() => {
    if (onboardingQuery.data) setOnboarding(onboardingQuery.data);
  }, [onboardingQuery.data]);

  const [availability, setAvailability] = useState<Array<Omit<AvailabilityRow, "id">>>([]);
  useEffect(() => {
    if (availabilityQuery.data) {
      setAvailability(availabilityQuery.data.map(({ day_of_week, start_time, end_time, preference }) => ({ day_of_week, start_time: start_time.slice(0, 5), end_time: end_time.slice(0, 5), preference })));
    }
  }, [availabilityQuery.data]);
  const slotsByDay = useMemo(
    () => Object.fromEntries(WEEKDAYS.map((day) => [day, availability.filter((row) => row.day_of_week === day)])) as Record<Weekday, Array<Omit<AvailabilityRow, "id">>>,
    [availability]
  );
  function addAvailabilitySlot(day: Weekday) {
    setAvailability((rows) => [...rows, { day_of_week: day, start_time: "09:00", end_time: "17:00", preference: "available" }]);
  }
  function updateAvailabilitySlot(day: Weekday, index: number, patch: Partial<Omit<AvailabilityRow, "id">>) {
    setAvailability((rows) => { let seen = -1; return rows.map((row) => { if (row.day_of_week !== day) return row; seen += 1; return seen === index ? { ...row, ...patch } : row; }); });
  }
  function removeAvailabilitySlot(day: Weekday, index: number) {
    setAvailability((rows) => { let seen = -1; return rows.filter((row) => { if (row.day_of_week !== day) return true; seen += 1; return seen !== index; }); });
  }
  function copyAvailabilityToDay(fromDay: Weekday, toDay: Weekday) {
    setAvailability((rows) => [
      ...rows.filter((row) => row.day_of_week !== toDay),
      ...rows.filter((row) => row.day_of_week === fromDay).map((row) => ({ ...row, day_of_week: toDay }))
    ]);
  }

  const availabilityMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("replace_candidate_availability", {
        target_organization_id: activeOrganizationId!,
        target_applicant_id: id!,
        availability_slots: availability.map(({ day_of_week, start_time, end_time, preference }) => ({ day_of_week, start_time, end_time, preference }))
      });
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-availability-v1", activeOrganizationId, id] })
  });
  const credentials = credentialsQuery.data ?? [];
  const credentialNames = new Set(credentials.map((row) => row.credential_type.toLowerCase()));
  const missingRequirements = (requirementsQuery.data ?? []).filter((row) => !credentialNames.has(row.name.toLowerCase()));

  const stageMutation = useMutation({
    mutationFn: async (nextStage: Stage) => {
      const { error } = await supabase.rpc("set_candidate_stage", { target_organization_id: activeOrganizationId!, target_applicant_id: id!, target_stage: nextStage, stage_note: stageNote || null });
      if (error) throw error;
    },
    onSuccess: () => { setStageNote(""); void queryClient.invalidateQueries({ queryKey: ["candidate-detail-v1", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["candidate-stage-history-v1", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["applicants", activeOrganizationId] }); }
  });

  const verifyMutation = useMutation({
    mutationFn: async ({ credentialId, verificationStatus }: { credentialId: string; verificationStatus: CredentialRow["verification_status"] }) => {
      const { error } = await supabase.from("candidate_credentials").update({ verification_status: verificationStatus, verified_by: user?.id ?? null, verified_at: new Date().toISOString() }).eq("organization_id", activeOrganizationId!).eq("id", credentialId);
      if (error) throw error;
    }, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-credentials-v1", activeOrganizationId, id] })
  });

  const onboardingMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("upsert_candidate_onboarding", { target_organization_id: activeOrganizationId!, target_applicant_id: id!, onboarding_payload: onboarding });
      if (error) throw error;
    }, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-onboarding-v1", activeOrganizationId, id] })
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("transfer_candidate_to_care_team", { target_organization_id: activeOrganizationId!, target_applicant_id: id! });
      if (error) throw error;
      return data as string;
    }, onSuccess: (recordId) => { void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] }); navigate(`/team/${recordId}`); }
  });

  const createPortalLinkMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("create_candidate_portal_link", { target_organization_id: activeOrganizationId!, target_applicant_id: id!, ttl_hours: Number(portalTtlHours) });
      if (error) throw error;
      const result = (Array.isArray(data) ? data[0] : data) as { token: string; expires_at: string };
      return `${window.location.origin}/candidate/${result.token}`;
    },
    onSuccess: (link) => { setNewPortalLink(link); void navigator.clipboard?.writeText(link); void queryClient.invalidateQueries({ queryKey: ["candidate-portal-links", activeOrganizationId, id] }); }
  });

  const revokePortalLinkMutation = useMutation({
    mutationFn: async (tokenId: string) => {
      const { error } = await supabase.rpc("revoke_candidate_portal_link", { target_organization_id: activeOrganizationId!, target_token_id: tokenId });
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-portal-links", activeOrganizationId, id] })
  });

  if (!canRead) return <Card><p className="text-sm text-slate-600">You do not have permission to view Candidates.</p></Card>;
  if (candidateQuery.isLoading) return <p className="text-sm text-slate-500">Loading candidate…</p>;
  if (candidateQuery.isError || !candidateQuery.data) return <p className="text-sm text-red-700">Could not load this candidate.</p>;

  const candidate = candidateQuery.data;
  const candidateName = `${candidate.preferred_name || candidate.first_name} ${candidate.last_name}`;
  const terminal = ["care_team", "rejected", "withdrawn"].includes(candidate.pipeline_stage);

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <Link to="/candidates" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="h-4 w-4" />Candidates</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">Candidate</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">{candidateName}</h1>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="font-mono text-sm font-medium text-slate-700">{candidate.candidate_code}</span>
            <button
              type="button"
              onClick={() => void copyCandidateId(candidate.candidate_code)}
              aria-label="Copy Candidate ID"
              className="text-slate-400 hover:text-slate-700"
            >
              <Clipboard className="h-3.5 w-3.5" />
            </button>
            {candidateIdCopied ? <span className="text-xs text-emerald-700">Copied</span> : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">{candidate.email ?? "No email"}{candidate.phone ? ` · ${candidate.phone}` : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <Button variant="secondary" onClick={() => setEditingCandidate((value) => !value)}>
              {editingCandidate ? "Cancel" : "Edit candidate"}
            </Button>
          ) : null}
          <StatusBadge label={title(candidate.pipeline_stage)} tone={candidate.pipeline_stage === "care_team" ? "success" : terminal ? "neutral" : "info"}/>
        </div>
      </div>

      {candidateSuccess ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">{candidateSuccess}</p> : null}

      {editingCandidate && canManage ? (
        <Card>
          <h2 className="font-semibold text-slate-950">Edit candidate</h2>
          <p className="mt-1 text-xs text-slate-500">First name, last name, and at least one of email or phone are required.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">First name<input value={candidateForm.first_name} onChange={(e) => setCandidateForm({ ...candidateForm, first_name: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Last name<input value={candidateForm.last_name} onChange={(e) => setCandidateForm({ ...candidateForm, last_name: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Preferred name<input value={candidateForm.preferred_name} onChange={(e) => setCandidateForm({ ...candidateForm, preferred_name: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Email<input type="email" value={candidateForm.email} onChange={(e) => setCandidateForm({ ...candidateForm, email: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Phone<input value={candidateForm.phone} onChange={(e) => setCandidateForm({ ...candidateForm, phone: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">
              Position
              <select value={candidateForm.position} onChange={(e) => setCandidateForm({ ...candidateForm, position: e.target.value as (typeof POSITION_OPTIONS)[number] | "" })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Select a position…</option>
                {POSITION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            {candidateForm.position === "Other" ? (
              <label className="text-xs font-medium text-slate-600">Specify position<input value={candidateForm.positionOther} onChange={(e) => setCandidateForm({ ...candidateForm, positionOther: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            ) : null}
            <label className="text-xs font-medium text-slate-600">
              Source
              <select value={candidateForm.source} onChange={(e) => setCandidateForm({ ...candidateForm, source: e.target.value as (typeof CANDIDATE_SOURCES)[number] })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                {CANDIDATE_SOURCES.map((source) => <option key={source} value={source}>{title(source)}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">Desired weekly hours<input type="number" min="0" max="168" value={candidateForm.desired_weekly_hours} onChange={(e) => setCandidateForm({ ...candidateForm, desired_weekly_hours: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">Street address<input value={candidateForm.address_street} onChange={(e) => setCandidateForm({ ...candidateForm, address_street: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">City<input value={candidateForm.address_city} onChange={(e) => setCandidateForm({ ...candidateForm, address_city: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">State<input value={candidateForm.address_state} onChange={(e) => setCandidateForm({ ...candidateForm, address_state: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600">ZIP<input value={candidateForm.address_zip} onChange={(e) => setCandidateForm({ ...candidateForm, address_zip: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">Notes<textarea value={candidateForm.notes} onChange={(e) => setCandidateForm({ ...candidateForm, notes: e.target.value })} className="mt-1 min-h-20 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>
          </div>
          {candidateError ? <p className="mt-3 text-sm text-red-700">{candidateError}</p> : null}
          <div className="mt-4">
            <Button disabled={!candidateCanSave || candidateSaving} loading={candidateSaving} onClick={() => void saveCandidate()}>Save candidate</Button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card><h2 className="font-semibold text-slate-950">Recruiting profile</h2><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-slate-500">Source</dt><dd className="mt-1 font-medium text-slate-900">{title(candidate.source)}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Position</dt><dd className="mt-1 font-medium text-slate-900">{candidate.position_applied_for ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Applied</dt><dd className="mt-1 font-medium text-slate-900">{candidate.applied_at ? new Date(candidate.applied_at).toLocaleDateString() : "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Start date</dt><dd className="mt-1 font-medium text-slate-900">{candidate.available_start_date ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Employment</dt><dd className="mt-1 font-medium text-slate-900">{candidate.employment_type ? title(candidate.employment_type) : "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Desired hours</dt><dd className="mt-1 font-medium text-slate-900">{candidate.desired_weekly_hours != null ? `${candidate.desired_weekly_hours}/week` : "—"}</dd></div><div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Address</dt><dd className="mt-1 font-medium text-slate-900">{formatAddress(candidate)}</dd></div><div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Languages</dt><dd className="mt-1 font-medium text-slate-900">{candidate.languages.length ? candidate.languages.join(", ") : "—"}</dd></div>{candidate.notes ? <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Notes</dt><dd className="mt-1 whitespace-pre-wrap font-medium text-slate-900">{candidate.notes}</dd></div> : null}</dl></Card>
        <Card><h2 className="font-semibold text-slate-950">Hiring Stage</h2>{canManage ? <div className="mt-4 space-y-3"><select value={candidate.pipeline_stage} onChange={(e) => stageMutation.mutate(e.target.value as Stage)} disabled={stageMutation.isPending} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">{(stagesQuery.data ?? []).map((stage) => <option key={stage.stage_key} value={stage.stage_key}>{stage.display_label}</option>)}</select><textarea value={stageNote} onChange={(e) => setStageNote(e.target.value)} placeholder="Optional note for the next stage change" className="min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></div> : <p className="mt-3 text-sm text-slate-500">Read-only.</p>}<div className="mt-5 border-t border-slate-100 pt-4"><p className="text-xs uppercase tracking-wide text-slate-500">History</p>{(historyQuery.data ?? []).length ? <ul className="mt-2 space-y-2">{(historyQuery.data ?? []).slice(0,8).map((row) => <li key={row.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm"><p className="font-medium text-slate-800">{title(row.to_stage)}</p><p className="text-xs text-slate-500">{new Date(row.changed_at).toLocaleString()}{row.note ? ` · ${row.note}` : ""}</p></li>)}</ul> : <p className="mt-2 text-sm text-slate-400">No stage changes yet.</p>}</div></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-950">Availability</h2>
              <p className="mt-1 text-sm text-slate-500">Multiple time windows per day are supported.</p>
            </div>
            {canManage ? <Button variant="secondary" loading={availabilityMutation.isPending} onClick={() => availabilityMutation.mutate()}>Save availability</Button> : null}
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {WEEKDAYS.map((day) => (
              <div key={day} className="rounded-lg border border-slate-200 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{title(day)}</p>
                  {canManage ? (
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => addAvailabilitySlot(day)} className="text-xs font-medium text-slate-700">+ Add time</button>
                      {slotsByDay[day].length > 0 ? (
                        <select
                          aria-label={`Copy ${title(day)} availability to`}
                          value=""
                          onChange={(e) => { if (e.target.value) copyAvailabilityToDay(day, e.target.value as Weekday); e.target.value = ""; }}
                          className="rounded-lg border border-slate-200 px-1.5 py-1 text-xs"
                        >
                          <option value="">Copy to…</option>
                          {WEEKDAYS.filter((other) => other !== day).map((other) => <option key={other} value={other}>{title(other)}</option>)}
                        </select>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {slotsByDay[day].length === 0 ? (
                  <p className="mt-1 text-xs text-slate-400">Not recorded</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {slotsByDay[day].map((slot, index) => (
                      <div key={`${day}-${index}`} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
                        <input aria-label={`${title(day)} window ${index + 1} start`} disabled={!canManage} type="time" value={slot.start_time} onChange={(e) => updateAvailabilitySlot(day, index, { start_time: e.target.value })} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"/>
                        <input aria-label={`${title(day)} window ${index + 1} end`} disabled={!canManage} type="time" value={slot.end_time} onChange={(e) => updateAvailabilitySlot(day, index, { end_time: e.target.value })} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"/>
                        <select aria-label={`${title(day)} window ${index + 1} preference`} disabled={!canManage} value={slot.preference} onChange={(e) => updateAvailabilitySlot(day, index, { preference: e.target.value as AvailabilityRow["preference"] })} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
                          <option value="available">Available</option>
                          <option value="preferred">Preferred</option>
                        </select>
                        {canManage ? <button type="button" onClick={() => removeAvailabilitySlot(day, index)} className="px-1 text-xs text-red-600">Remove</button> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {availabilityMutation.isError ? <p className="mt-3 text-sm text-red-700">Could not save availability.</p> : null}
          {availabilityMutation.isSuccess ? <p className="mt-3 text-sm text-emerald-700">Availability saved.</p> : null}
        </Card>
        <Card><h2 className="font-semibold text-slate-950">Work preferences</h2><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><p><span className="text-slate-500">Shift range:</span> {candidate.min_shift_hours ?? "?"}–{candidate.max_shift_hours ?? "?"}h</p><p><span className="text-slate-500">Max travel:</span> {candidate.max_travel_minutes != null ? `${candidate.max_travel_minutes} min` : "—"}</p><p><span className="text-slate-500">Transportation:</span> {candidate.transportation_method ?? "—"}</p><p><span className="text-slate-500">Reliable transportation:</span> {candidate.reliable_transportation == null ? "—" : candidate.reliable_transportation ? "Yes" : "No"}</p><p><span className="text-slate-500">Driver license:</span> {candidate.valid_drivers_license == null ? "—" : candidate.valid_drivers_license ? "Yes" : "No"}</p><p><span className="text-slate-500">Auto insurance:</span> {candidate.auto_insurance == null ? "—" : candidate.auto_insurance ? "Yes" : "No"}</p></div></Card>
      </div>

      <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-950">Credentials & requirements</h2><p className="mt-1 text-sm text-slate-500">Candidate-submitted information is separate from staff verification.</p></div><StatusBadge label={`${missingRequirements.length} required missing`} tone={missingRequirements.length ? "warning" : "success"}/></div>{missingRequirements.length ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Missing: {missingRequirements.map((row) => row.name).join(", ")}</p> : null}{credentials.length ? <div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-2 py-2">Credential</th><th className="px-2 py-2">Expiration</th><th className="px-2 py-2">Verification</th><th className="px-2 py-2"></th></tr></thead><tbody>{credentials.map((row) => <tr key={row.id} className="border-b border-slate-100"><td className="px-2 py-3"><p className="font-medium text-slate-900">{row.credential_type}</p><p className="text-xs text-slate-500">{row.issuing_organization ?? ""}{row.credential_number ? ` · ${row.credential_number}` : ""}</p></td><td className="px-2 py-3">{row.does_not_expire ? "Does not expire" : row.expiration_date ?? "—"}</td><td className="px-2 py-3"><StatusBadge label={title(row.verification_status)} tone={row.verification_status === "verified" ? "success" : row.verification_status === "rejected" ? "danger" : "warning"}/></td><td className="px-2 py-3 text-right">{canManage ? <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" disabled={verifyMutation.isPending || row.verification_status === "verified"} onClick={() => verifyMutation.mutate({credentialId:row.id,verificationStatus:"verified"})}>Verify</Button><Button size="sm" variant="secondary" disabled={verifyMutation.isPending || row.verification_status === "rejected"} onClick={() => verifyMutation.mutate({credentialId:row.id,verificationStatus:"rejected"})}>Reject</Button></div> : null}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-slate-400">No credentials submitted.</p>}</Card>

      <Card><h2 className="font-semibold text-slate-950">Onboarding</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-slate-600">Status<select disabled={!canManage} value={onboarding.status} onChange={(e) => setOnboarding({...onboarding,status:e.target.value})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="not_scheduled">Not scheduled</option><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label><label className="text-xs font-medium text-slate-600">Scheduled date/time<input disabled={!canManage} type="datetime-local" value={onboarding.scheduled_at?.slice(0,16) ?? ""} onChange={(e) => setOnboarding({...onboarding,scheduled_at:e.target.value || null})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600">Method<input disabled={!canManage} value={onboarding.method ?? ""} onChange={(e) => setOnboarding({...onboarding,method:e.target.value || null})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600">Location<input disabled={!canManage} value={onboarding.location ?? ""} onChange={(e) => setOnboarding({...onboarding,location:e.target.value || null})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600">Background check<select disabled={!canManage} value={onboarding.background_check_status} onChange={(e) => setOnboarding({...onboarding,background_check_status:e.target.value})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="not_started">Not started</option><option value="requested">Requested</option><option value="submitted">Submitted</option><option value="pending">Pending</option><option value="complete">Complete</option><option value="needs_attention">Needs attention</option></select></label><label className="text-xs font-medium text-slate-600">Compliance<select disabled={!canManage} value={onboarding.compliance_status} onChange={(e) => setOnboarding({...onboarding,compliance_status:e.target.value})} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="pending">Pending</option><option value="needs_attention">Needs attention</option><option value="complete">Complete</option></select></label><label className="text-xs font-medium text-slate-600 sm:col-span-2">Instructions<textarea disabled={!canManage} value={onboarding.instructions ?? ""} onChange={(e) => setOnboarding({...onboarding,instructions:e.target.value || null})} className="mt-1 min-h-20 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600 sm:col-span-2">Internal notes<textarea disabled={!canManage} value={onboarding.notes ?? ""} onChange={(e) => setOnboarding({...onboarding,notes:e.target.value || null})} className="mt-1 min-h-20 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label></div>{canManage ? <div className="mt-4"><Button loading={onboardingMutation.isPending} onClick={() => onboardingMutation.mutate()}>Save onboarding</Button></div> : null}</Card>

      <DocumentsCard
        organizationId={activeOrganizationId}
        subjectType="applicant"
        subjectId={candidate.id}
        subjectName={`${candidate.first_name} ${candidate.last_name}`}
        subjectEmail={candidate.email}
        canRead={canReadDocuments}
        canManage={canManageDocuments}
      />

      <Card><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold text-slate-950">Create Care Team workforce record</h2><p className="mt-1 text-sm text-slate-500">Authorized staff can copy the existing profile, availability and credentials into a workforce record. A login account is not required.</p></div>{candidate.pipeline_stage === "care_team" ? <StatusBadge label="Workforce record created" tone="success"/> : canTransfer ? <Button loading={transferMutation.isPending} onClick={() => transferMutation.mutate()}>Create workforce record</Button> : null}</div>{transferMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not create the workforce record.</p> : null}</Card>
      {canManage ? <Card><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold text-slate-950">Candidate self-service link</h2><p className="mt-1 text-sm text-slate-500">Create a secure expiring link. Only a newly generated link can be copied because Ogevia stores its hash.</p></div><div className="flex items-end gap-2"><label className="text-xs font-medium text-slate-600">Expires in<select value={portalTtlHours} onChange={(event) => setPortalTtlHours(event.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option><option value="336">14 days</option><option value="720">30 days</option></select></label><Button loading={createPortalLinkMutation.isPending} onClick={() => createPortalLinkMutation.mutate()}><Link2 className="mr-1.5 h-4 w-4"/>Create link</Button></div></div>{newPortalLink ? <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3"><p className="min-w-0 flex-1 break-all text-sm text-emerald-900">{newPortalLink}</p><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(newPortalLink)}><Clipboard className="mr-1 h-4 w-4"/>Copy</Button></div> : null}{createPortalLinkMutation.isError ? <p className="mt-3 text-sm text-red-700">Could not create the link.</p> : null}<div className="mt-4 space-y-2">{(portalTokensQuery.data ?? []).map((row) => { const active = !row.revoked_at && new Date(row.expires_at) > new Date(); return <div key={row.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"><div><StatusBadge label={active ? "Active" : row.revoked_at ? "Revoked" : "Expired"} tone={active ? "success" : "neutral"}/><span className="ml-2 text-slate-500">Expires {new Date(row.expires_at).toLocaleString()}</span>{row.last_used_at ? <span className="ml-2 text-xs text-slate-400">Last used {new Date(row.last_used_at).toLocaleString()}</span> : null}</div>{active ? <Button size="sm" variant="secondary" loading={revokePortalLinkMutation.isPending} onClick={() => revokePortalLinkMutation.mutate(row.id)}><X className="mr-1 h-4 w-4"/>Revoke</Button> : null}</div>; })}</div></Card> : null}
    </section>
  );
}
