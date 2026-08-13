import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
type Stage =
  | "imported"
  | "application_needed"
  | "application_received"
  | "screening"
  | "interview"
  | "conditional_offer"
  | "hired_onboarding_required"
  | "onboarding_scheduled"
  | "onboarding"
  | "compliance_pending"
  | "ready_to_work"
  | "care_team"
  | "on_hold"
  | "rejected"
  | "withdrawn";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface CandidateRow {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  email: string;
  phone: string | null;
  alternate_phone: string | null;
  address_street: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  pipeline_stage: Stage;
  source: string;
  source_record_id: string | null;
  position_applied_for: string | null;
  applied_at: string | null;
  employment_type: string | null;
  available_start_date: string | null;
  desired_weekly_hours: number | null;
  min_weekly_hours: number | null;
  max_weekly_hours: number | null;
  min_shift_hours: number | null;
  max_shift_hours: number | null;
  max_travel_minutes: number | null;
  transportation_method: string | null;
  reliable_transportation: boolean | null;
  willing_to_transport_clients: boolean | null;
  valid_drivers_license: boolean | null;
  vehicle_available: boolean | null;
  auto_insurance: boolean | null;
  languages: string[];
  notes: string | null;
}

interface StageOption { stage_key: Stage; display_label: string; sort_order: number; is_active: boolean; }
interface AvailabilityRow { id: string; day_of_week: Weekday; start_time: string; end_time: string; preference: "available" | "preferred"; }
interface CredentialRow {
  id: string;
  credential_type: string;
  issue_date: string | null;
  expiration_date: string | null;
  does_not_expire: boolean;
  issuing_organization: string | null;
  credential_number: string | null;
  submission_status: string;
  verification_status: "unverified" | "verified" | "rejected";
  verified_at: string | null;
  notes: string | null;
}
interface RequirementRow { credential_type_id: string; name: string; category: string | null; requires_expiration: boolean; is_required: boolean; is_active: boolean; source: string; }
interface OnboardingRow {
  status: string;
  scheduled_at: string | null;
  method: string | null;
  location: string | null;
  instructions: string | null;
  notes: string | null;
  background_check_status: string;
  compliance_status: string;
  completed_at: string | null;
}
interface StageHistoryRow { id: string; from_stage: string | null; to_stage: string; note: string | null; changed_at: string; }
interface PortalTokenRow { id: string; expires_at: string; revoked_at: string | null; created_at: string; }

function title(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAddress(candidate: CandidateRow) {
  const street = [candidate.address_street, candidate.address_line2].filter(Boolean).join(", ");
  const locality = [candidate.address_city, candidate.address_state, candidate.address_zip].filter(Boolean).join(" ");
  return [street, locality].filter(Boolean).join(" · ") || "—";
}

function toneForVerification(status: CredentialRow["verification_status"]) {
  if (status === "verified") return "success" as const;
  if (status === "rejected") return "danger" as const;
  return "warning" as const;
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

  const candidateQuery = useQuery({
    queryKey: ["candidate-detail-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_applicants")
        .select("*")
        .eq("organization_id", activeOrganizationId!)
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as CandidateRow;
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const stagesQuery = useQuery({
    queryKey: ["candidate-stage-options", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_candidate_pipeline_stages", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return ((data ?? []) as StageOption[]).filter((row) => row.is_active);
    },
    enabled: !!activeOrganizationId && canRead
  });

  const availabilityQuery = useQuery({
    queryKey: ["candidate-availability-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_applicant_availability")
        .select("id, day_of_week, start_time, end_time, preference")
        .eq("organization_id", activeOrganizationId!)
        .eq("applicant_id", id!);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const credentialsQuery = useQuery({
    queryKey: ["candidate-credentials-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("candidate_credentials")
        .select("id, credential_type, issue_date, expiration_date, does_not_expire, issuing_organization, credential_number, submission_status, verification_status, verified_at, notes")
        .eq("organization_id", activeOrganizationId!)
        .eq("applicant_id", id!)
        .is("deleted_at", null)
        .order("credential_type");
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const requirementsQuery = useQuery({
    queryKey: ["candidate-requirements-v1", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_credential_types", {
        target_organization_id: activeOrganizationId!,
        target_applies_to: "candidate"
      });
      if (error) throw error;
      return ((data ?? []) as RequirementRow[]).filter((row) => row.is_active && row.is_required);
    },
    enabled: !!activeOrganizationId && canRead
  });

  const onboardingQuery = useQuery({
    queryKey: ["candidate-onboarding-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("candidate_onboarding")
        .select("status, scheduled_at, method, location, instructions, notes, background_check_status, compliance_status, completed_at")
        .eq("organization_id", activeOrganizationId!)
        .eq("applicant_id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as OnboardingRow | null;
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const historyQuery = useQuery({
    queryKey: ["candidate-stage-history-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("candidate_stage_history")
        .select("id, from_stage, to_stage, note, changed_at")
        .eq("organization_id", activeOrganizationId!)
        .eq("applicant_id", id!)
        .order("changed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as StageHistoryRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const tokenQuery = useQuery({
    queryKey: ["candidate-portal-tokens-v1", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("candidate_portal_tokens")
        .select("id, expires_at, revoked_at, created_at")
        .eq("organization_id", activeOrganizationId!)
        .eq("applicant_id", id!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PortalTokenRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const [stageNote, setStageNote] = useState("");
  const [portalLink, setPortalLink] = useState<string | null>(null);
  const [portalMessage, setPortalMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingRow>({
    status: "not_scheduled",
    scheduled_at: null,
    method: null,
    location: null,
    instructions: null,
    notes: null,
    background_check_status: "not_started",
    compliance_status: "pending",
    completed_at: null
  });

  const currentOnboarding = onboardingQuery.data ?? onboarding;
  const credentials = credentialsQuery.data ?? [];
  const requirementNames = new Set((requirementsQuery.data ?? []).map((row) => row.name.toLowerCase()));
  const submittedCredentialNames = new Set(credentials.map((row) => row.credential_type.toLowerCase()));
  const missingRequirements = (requirementsQuery.data ?? []).filter((row) => !submittedCredentialNames.has(row.name.toLowerCase()));

  const groupedAvailability = useMemo(() => {
    return WEEKDAYS.map((day) => ({
      day,
      rows: (availabilityQuery.data ?? []).filter((row) => row.day_of_week === day).sort((a, b) => a.start_time.localeCompare(b.start_time))
    })).filter((entry) => entry.rows.length > 0);
  }, [availabilityQuery.data]);

  const stageMutation = useMutation({
    mutationFn: async (nextStage: Stage) => {
      const { error } = await supabase.rpc("set_candidate_stage", {
        target_organization_id: activeOrganizationId!,
        target_applicant_id: id!,
        target_stage: nextStage,
        stage_note: stageNote || null
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setStageNote("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["candidate-detail-v1", activeOrganizationId, id] }),
        queryClient.invalidateQueries({ queryKey: ["candidate-stage-history-v1", activeOrganizationId, id] }),
        queryClient.invalidateQueries({ queryKey: ["applicants", activeOrganizationId] })
      ]);
    }
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("create_candidate_portal_link", {
        target_organization_id: activeOrganizationId!,
        target_applicant_id: id!,
        ttl_hours: 168
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.token) throw new Error("Candidate link was not returned.");
      return `${window.location.origin}/candidate/${row.token}`;
    },
    onSuccess: (link) => {
      setPortalLink(link);
      setPortalMessage("A new candidate link was created. It expires in 7 days.");
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["candidate-portal-tokens-v1", activeOrganizationId, id] });
    }
  });

  const onboardingMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...currentOnboarding,
        scheduled_at: currentOnboarding.scheduled_at || null,
        completed_at: currentOnboarding.completed_at || null
      };
      const { error } = await supabase.rpc("upsert_candidate_onboarding", {
        target_organization_id: activeOrganizationId!,
        target_applicant_id: id!,
        onboarding_payload: payload
      });
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-onboarding-v1", activeOrganizationId, id] })
  });

  const verifyMutation = useMutation({
    mutationFn: async ({ credentialId, status }: { credentialId: string; status: CredentialRow["verification_status"] }) => {
      const { error } = await supabase
        .from("candidate_credentials")
        .update({
          verification_status: status,
          verified_by: status === "unverified" ? null : user?.id ?? null,
          verified_at: status === "unverified" ? null : new Date().toISOString()
        })
        .eq("organization_id", activeOrganizationId!)
        .eq("id", credentialId);
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["candidate-credentials-v1", activeOrganizationId, id] })
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("transfer_candidate_to_care_team", {
        target_organization_id: activeOrganizationId!,
        target_applicant_id: id!
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (caregiverRecordId) => {
      void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] });
      navigate(`/team/${caregiverRecordId}`);
    }
  });

  function setOnboardingField<K extends keyof OnboardingRow>(key: K, value: OnboardingRow[K]) {
    setOnboarding({ ...currentOnboarding, [key]: value });
  }

  async function copyPortalLink() {
    if (!portalLink) return;
    try {
      await navigator.clipboard.writeText(portalLink);
      setCopied(true);
    } catch {
      setPortalMessage("Copy failed. Select the link and copy it manually.");
    }
  }

  if (!canRead) return <Card><p className="text-sm text-slate-600">You do not have permission to view Candidates.</p></Card>;
  if (candidateQuery.isLoading) return <p className="text-sm text-slate-500">Loading candidate…</p>;
  if (candidateQuery.isError || !candidateQuery.data) return <p className="text-sm text-red-700">Could not load this candidate.</p>;

  const candidate = candidateQuery.data;
  const candidateName = `${candidate.preferred_name || candidate.first_name} ${candidate.last_name}`;
  const terminal = ["care_team", "rejected", "withdrawn"].includes(candidate.pipeline_stage);
  const latestToken = (tokenQuery.data ?? [])[0];

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <Link to="/applicants" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Candidates
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">Candidate</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">{candidateName}</h1>
          <p className="mt-1 text-sm text-slate-500">{candidate.email}{candidate.phone ? ` · ${candidate.phone}` : ""}</p>
        </div>
        <StatusBadge label={title(candidate.pipeline_stage)} tone={candidate.pipeline_stage === "care_team" ? "success" : terminal ? "neutral" : "info"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-slate-950">Recruiting profile</h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Source</dt><dd className="mt-1 font-medium text-slate-900">{title(candidate.source)}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Position</dt><dd className="mt-1 font-medium text-slate-900">{candidate.position_applied_for ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Applied</dt><dd className="mt-1 font-medium text-slate-900">{candidate.applied_at ? new Date(candidate.applied_at).toLocaleDateString() : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Start date</dt><dd className="mt-1 font-medium text-slate-900">{candidate.available_start_date ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Employment</dt><dd className="mt-1 font-medium text-slate-900">{candidate.employment_type ? title(candidate.employment_type) : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Desired hours</dt><dd className="mt-1 font-medium text-slate-900">{candidate.desired_weekly_hours != null ? `${candidate.desired_weekly_hours} / week` : "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Address</dt><dd className="mt-1 font-medium text-slate-900">{formatAddress(candidate)}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Languages</dt><dd className="mt-1 font-medium text-slate-900">{candidate.languages.length ? candidate.languages.join(", ") : "—"}</dd></div>
          </dl>
        </Card>

        <Card>
          <h2 className="font-semibold text-slate-950">Pipeline</h2>
          {canManage ? (
            <div className="mt-4 space-y-3">
              <select
                value={candidate.pipeline_stage}
                onChange={(event) => stageMutation.mutate(event.target.value as Stage)}
                disabled={stageMutation.isPending}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                {(stagesQuery.data ?? []).map((stage) => <option key={stage.stage_key} value={stage.stage_key}>{stage.display_label}</option>)}
              </select>
              <textarea value={stageNote} onChange={(event) => setStageNote(event.target.value)} placeholder="Optional note for the next stage change" className="min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              {stageMutation.isError ? <p className="text-sm text-red-700">Could not update the candidate stage.</p> : null}
            </div>
          ) : <p className="mt-3 text-sm text-slate-500">Read-only pipeline access.</p>}

          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">History</p>
            {(historyQuery.data ?? []).length === 0 ? <p className="mt-2 text-sm text-slate-400">No stage changes recorded yet.</p> : (
              <ul className="mt-2 space-y-2 text-sm">
                {(historyQuery.data ?? []).slice(0, 8).map((row) => (
                  <li key={row.id} className="rounded-lg bg-slate-50 px-3 py-2">
                    <p className="font-medium text-slate-800">{title(row.to_stage)}</p>
                    <p className="text-xs text-slate-500">{new Date(row.changed_at).toLocaleString()}{row.note ? ` · ${row.note}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-950">Candidate self-service link</h2>
            <p className="mt-1 text-sm text-slate-500">Use a temporary link so the candidate can complete profile, availability and credential information without an Ogevia login.</p>
          </div>
          {canManage && !terminal ? <Button onClick={() => portalMutation.mutate()} loading={portalMutation.isPending}>Create 7-day link</Button> : null}
        </div>
        {latestToken ? <p className="mt-3 text-xs text-slate-500">Latest link: {latestToken.revoked_at ? "revoked" : new Date(latestToken.expires_at) > new Date() ? `expires ${new Date(latestToken.expires_at).toLocaleString()}` : "expired"}</p> : null}
        {portalLink ? (
          <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-3">
            <div className="flex flex-wrap items-center gap-2"><a href={portalLink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all text-sm text-emerald-800 underline">{portalLink}</a><Button variant="secondary" size="sm" onClick={() => void copyPortalLink()}><Copy className="mr-1 h-4 w-4" />{copied ? "Copied" : "Copy"}</Button><a href={portalLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-emerald-800"><ExternalLink className="h-4 w-4" />Open</a></div>
          </div>
        ) : null}
        {portalMessage ? <p className="mt-2 text-sm text-slate-600">{portalMessage}</p> : null}
        {portalMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not create the candidate link.</p> : null}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-slate-950">Weekly availability</h2>
          {groupedAvailability.length === 0 ? <p className="mt-3 text-sm text-slate-400">No availability submitted yet.</p> : (
            <div className="mt-3 space-y-3">
              {groupedAvailability.map(({ day, rows }) => <div key={day} className="grid grid-cols-[100px_1fr] gap-3 text-sm"><p className="font-medium text-slate-800">{title(day)}</p><div className="space-y-1">{rows.map((row) => <p key={row.id} className="text-slate-600">{row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)}{row.preference === "preferred" ? " · Preferred" : ""}</p>)}</div></div>)}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-semibold text-slate-950">Work & travel preferences</h2>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <p><span className="text-slate-500">Shift range:</span> <span className="font-medium text-slate-900">{candidate.min_shift_hours ?? "?"}–{candidate.max_shift_hours ?? "?"}h</span></p>
            <p><span className="text-slate-500">Max travel:</span> <span className="font-medium text-slate-900">{candidate.max_travel_minutes != null ? `${candidate.max_travel_minutes} min` : "—"}</span></p>
            <p><span className="text-slate-500">Transportation:</span> <span className="font-medium text-slate-900">{candidate.transportation_method ?? "—"}</span></p>
            <p><span className="text-slate-500">Reliable transportation:</span> <span className="font-medium text-slate-900">{candidate.reliable_transportation == null ? "—" : candidate.reliable_transportation ? "Yes" : "No"}</span></p>
            <p><span className="text-slate-500">Driver license:</span> <span className="font-medium text-slate-900">{candidate.valid_drivers_license == null ? "—" : candidate.valid_drivers_license ? "Yes" : "No"}</span></p>
            <p><span className="text-slate-500">Auto insurance:</span> <span className="font-medium text-slate-900">{candidate.auto_insurance == null ? "—" : candidate.auto_insurance ? "Yes" : "No"}</span></p>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-950">Credentials & requirements</h2><p className="mt-1 text-sm text-slate-500">Candidate-submitted information remains separate from organization verification.</p></div>{requirementNames.size ? <StatusBadge label={`${missingRequirements.length} required missing`} tone={missingRequirements.length ? "warning" : "success"} /> : null}</div>
        {missingRequirements.length ? <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-amber-800">Missing required items</p><p className="mt-1 text-sm text-amber-900">{missingRequirements.map((row) => row.name).join(", ")}</p></div> : null}
        {credentials.length === 0 ? <p className="mt-3 text-sm text-slate-400">No credentials submitted yet.</p> : (
          <div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-2 py-2">Credential</th><th className="px-2 py-2">Expires</th><th className="px-2 py-2">Verification</th><th className="px-2 py-2"></th></tr></thead><tbody>{credentials.map((credential) => <tr key={credential.id} className="border-b border-slate-100"><td className="px-2 py-3"><p className="font-medium text-slate-900">{credential.credential_type}</p><p className="text-xs text-slate-500">{credential.issuing_organization ?? ""}{credential.credential_number ? ` · ${credential.credential_number}` : ""}</p></td><td className="px-2 py-3 text-slate-600">{credential.does_not_expire ? "Does not expire" : credential.expiration_date ?? "—"}</td><td className="px-2 py-3"><StatusBadge label={title(credential.verification_status)} tone={toneForVerification(credential.verification_status)} /></td><td className="px-2 py-3 text-right">{canManage ? <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" disabled={verifyMutation.isPending || credential.verification_status === "verified"} onClick={() => verifyMutation.mutate({ credentialId: credential.id, status: "verified" })}>Verify</Button><Button size="sm" variant="secondary" disabled={verifyMutation.isPending || credential.verification_status === "rejected"} onClick={() => verifyMutation.mutate({ credentialId: credential.id, status: "rejected" })}>Reject</Button></div> : null}</td></tr>)}</tbody></table></div>
        )}
      </Card>

      <Card>
        <h2 className="font-semibold text-slate-950">Onboarding</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-600">Status<select value={currentOnboarding.status} disabled={!canManage} onChange={(e) => setOnboardingField("status", e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="not_scheduled">Not scheduled</option><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
          <label className="text-xs font-medium text-slate-600">Scheduled date/time<input type="datetime-local" value={currentOnboarding.scheduled_at?.slice(0, 16) ?? ""} disabled={!canManage} onChange={(e) => setOnboardingField("scheduled_at", e.target.value || null)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-slate-600">Method<input value={currentOnboarding.method ?? ""} disabled={!canManage} onChange={(e) => setOnboardingField("method", e.target.value || null)} placeholder="In person, video, phone" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-slate-600">Location<input value={currentOnboarding.location ?? ""} disabled={!canManage} onChange={(e) => setOnboardingField("location", e.target.value || null)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-slate-600">Background check<select value={currentOnboarding.background_check_status} disabled={!canManage} onChange={(e) => setOnboardingField("background_check_status", e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="not_started">Not started</option><option value="requested">Requested</option><option value="submitted">Submitted</option><option value="pending">Pending</option><option value="complete">Complete</option><option value="needs_attention">Needs attention</option></select></label>
          <label className="text-xs font-medium text-slate-600">Compliance<select value={currentOnboarding.compliance_status} disabled={!canManage} onChange={(e) => setOnboardingField("compliance_status", e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="pending">Pending</option><option value="needs_attention">Needs attention</option><option value="complete">Complete</option></select></label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">Instructions<textarea value={currentOnboarding.instructions ?? ""} disabled={!canManage} onChange={(e) => setOnboardingField("instructions", e.target.value || null)} className="mt-1 min-h-20 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">Internal notes<textarea value={currentOnboarding.notes ?? ""} disabled={!canManage} onChange={(e) => setOnboardingField("notes", e.target.value || null)} className="mt-1 min-h-20 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
        </div>
        {canManage ? <div className="mt-4"><Button onClick={() => onboardingMutation.mutate()} loading={onboardingMutation.isPending}>Save onboarding</Button></div> : null}
        {onboardingMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not save onboarding.</p> : null}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="font-semibold text-slate-950">Move to Care Team</h2><p className="mt-1 text-sm text-slate-500">Creates a workforce record from this candidate without requiring a login account. Profile, availability and credentials are copied automatically.</p></div>
          {candidate.pipeline_stage === "care_team" ? <StatusBadge label="Already in Care Team" tone="success" /> : canTransfer ? <Button onClick={() => transferMutation.mutate()} loading={transferMutation.isPending}>Move to Care Team</Button> : null}
        </div>
        {transferMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not move this candidate to Care Team.</p> : null}
      </Card>
    </section>
  );
}
