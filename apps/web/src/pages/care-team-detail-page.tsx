import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { DocumentsCard } from "@/components/documents-card";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
type Preference = "available" | "preferred";
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface WorkforceRecord {
  id: string;
  applicant_id: string | null;
  linked_user_id: string | null;
  caregiver_code: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  email: string | null;
  phone: string | null;
  alternate_phone: string | null;
  address_street: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  employment_type: string | null;
  available_start_date: string | null;
  desired_weekly_hours: number | null;
  min_weekly_hours: number | null;
  max_weekly_hours: number | null;
  min_shift_hours: number | null;
  max_shift_hours: number | null;
  max_travel_minutes: number | null;
  languages: string[];
  status: "onboarding" | "ready" | "active" | "inactive";
  onboarding_status: string | null;
  onboarding_scheduled_at: string | null;
  onboarding_method: string | null;
  onboarding_location: string | null;
  onboarding_instructions: string | null;
  background_check_status: string | null;
  compliance_status: string | null;
}
interface AvailabilityRow { id?: string; day_of_week: Weekday; start_time: string; end_time: string; preference: Preference; }
interface CredentialRow { id: string; credential_type: string; issue_date: string | null; expiration_date: string | null; does_not_expire: boolean; issuing_organization: string | null; credential_number: string | null; verification_status: string; }
interface MemberRow { user_id: string; display_name: string; status: string; role: string; }
interface ShiftHistoryRow { id: string; client_name: string; caregiver_record_id: string | null; starts_at: string; ends_at: string; status: string; }
interface AssignmentHistoryRow { id: string; caregiver_user_id: string; client_name: string; service_name: string; is_active: boolean; effective_start: string; effective_end: string | null; }

function title(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function time(value: string) { return value.slice(0, 5); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function CareTeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const canRead = hasPermission("membership.read");
  const canManage = hasPermission("membership.update");
  const canManageCredentials = hasPermission("credentials.update");
  const canReadDocuments = hasPermission("documents.read");
  const canManageDocuments = hasPermission("documents.manage");

  const recordQuery = useQuery({
    queryKey: ["care-team-record", activeOrganizationId, id],
    queryFn: async () => {
      if (!id || !isUuid(id)) throw new Error("Invalid Care Team record identifier");
      // Existing schedule/search links use the linked auth user ID, while
      // the canonical Care Team route uses the workforce record ID.
      const { data, error } = await supabase.from("caregiver_records").select("*").eq("organization_id", activeOrganizationId!).or(`id.eq.${id!},linked_user_id.eq.${id!}`).is("deleted_at", null).single();
      if (error) throw error;
      return data as WorkforceRecord;
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const availabilityQuery = useQuery({
    queryKey: ["care-team-availability", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_record_availability").select("id, day_of_week, start_time, end_time, preference").eq("organization_id", activeOrganizationId!).eq("caregiver_record_id", recordQuery.data!.id);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    },
    enabled: !!activeOrganizationId && !!recordQuery.data?.id && canRead
  });

  const credentialsQuery = useQuery({
    queryKey: ["care-team-credentials", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_record_credentials").select("id, credential_type, issue_date, expiration_date, does_not_expire, issuing_organization, credential_number, verification_status").eq("organization_id", activeOrganizationId!).eq("caregiver_record_id", recordQuery.data!.id).is("deleted_at", null).order("credential_type");
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    },
    enabled: !!activeOrganizationId && !!recordQuery.data?.id && canRead
  });

  const membersQuery = useQuery({
    queryKey: ["care-team-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return ((data ?? []) as MemberRow[]).filter((row) => row.status === "active");
    },
    enabled: !!activeOrganizationId && canManage
  });

  const canReadShifts = hasPermission("shifts.read");
  const canReadAssignments = hasPermission("assignments.read");

  // list_shifts() is org-wide and unbounded by default (no from_time/to_time
  // passed) - same pattern caregiver-detail-page.tsx used for this exact
  // purpose before that page stopped being routed. Naturally bounded here
  // by filtering to one caregiver_record_id, not by the query itself.
  const shiftsQuery = useQuery({
    queryKey: ["care-team-shifts", activeOrganizationId, recordQuery.data?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return ((data ?? []) as ShiftHistoryRow[]).filter((row) => row.caregiver_record_id === recordQuery.data!.id);
    },
    enabled: !!activeOrganizationId && !!recordQuery.data?.id && canReadShifts
  });

  // caregiver_assignments has no caregiver_record_id column yet (still
  // caregiver_user_id-only), so this can only show assignments for a
  // workforce record that has a linked login - a real, separate gap for a
  // workforce-only caregiver, not something this page can work around.
  const assignmentsQuery = useQuery({
    queryKey: ["care-team-assignments", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_assignments", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return (data ?? []) as AssignmentHistoryRow[];
    },
    enabled: !!activeOrganizationId && !!recordQuery.data?.linked_user_id && canReadAssignments
  });
  const assignmentsForRecord = (assignmentsQuery.data ?? []).filter(
    (row) => row.caregiver_user_id === recordQuery.data?.linked_user_id
  );

  const [status, setStatus] = useState<WorkforceRecord["status"]>("active");
  const [hours, setHours] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [credentialType, setCredentialType] = useState("");
  const [credentialIssue, setCredentialIssue] = useState("");
  const [credentialExpiration, setCredentialExpiration] = useState("");
  const [profile, setProfile] = useState({ first_name: "", last_name: "", preferred_name: "", email: "", phone: "", address_street: "", address_city: "", address_state: "", address_zip: "", employment_type: "", available_start_date: "", min_weekly_hours: "", max_weekly_hours: "", min_shift_hours: "", max_shift_hours: "", max_travel_minutes: "", languages: "" });

  useEffect(() => {
    if (recordQuery.data) {
      setStatus(recordQuery.data.status);
      setHours(recordQuery.data.desired_weekly_hours?.toString() ?? "");
      setSelectedUserId(recordQuery.data.linked_user_id ?? "");
      setProfile({ first_name: recordQuery.data.first_name, last_name: recordQuery.data.last_name, preferred_name: recordQuery.data.preferred_name ?? "", email: recordQuery.data.email ?? "", phone: recordQuery.data.phone ?? "", address_street: recordQuery.data.address_street ?? "", address_city: recordQuery.data.address_city ?? "", address_state: recordQuery.data.address_state ?? "", address_zip: recordQuery.data.address_zip ?? "", employment_type: recordQuery.data.employment_type ?? "", available_start_date: recordQuery.data.available_start_date ?? "", min_weekly_hours: recordQuery.data.min_weekly_hours?.toString() ?? "", max_weekly_hours: recordQuery.data.max_weekly_hours?.toString() ?? "", min_shift_hours: recordQuery.data.min_shift_hours?.toString() ?? "", max_shift_hours: recordQuery.data.max_shift_hours?.toString() ?? "", max_travel_minutes: recordQuery.data.max_travel_minutes?.toString() ?? "", languages: recordQuery.data.languages.join(", ") });
    }
  }, [recordQuery.data]);

  useEffect(() => {
    if (availabilityQuery.data) setAvailability(availabilityQuery.data.map((row) => ({ ...row, start_time: time(row.start_time), end_time: time(row.end_time) })));
  }, [availabilityQuery.data]);

  const slotsByDay = useMemo(() => Object.fromEntries(WEEKDAYS.map((day) => [day, availability.filter((row) => row.day_of_week === day)])) as Record<Weekday, AvailabilityRow[]>, [availability]);

  const saveRecordMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("caregiver_records").update({ ...profile, preferred_name: profile.preferred_name || null, email: profile.email || null, phone: profile.phone || null, address_street: profile.address_street || null, address_city: profile.address_city || null, address_state: profile.address_state || null, address_zip: profile.address_zip || null, employment_type: profile.employment_type || null, available_start_date: profile.available_start_date || null, desired_weekly_hours: hours ? Number(hours) : null, min_weekly_hours: profile.min_weekly_hours ? Number(profile.min_weekly_hours) : null, max_weekly_hours: profile.max_weekly_hours ? Number(profile.max_weekly_hours) : null, min_shift_hours: profile.min_shift_hours ? Number(profile.min_shift_hours) : null, max_shift_hours: profile.max_shift_hours ? Number(profile.max_shift_hours) : null, max_travel_minutes: profile.max_travel_minutes ? Number(profile.max_travel_minutes) : null, languages: profile.languages.split(",").map((value) => value.trim()).filter(Boolean), status }).eq("organization_id", activeOrganizationId!).eq("id", recordQuery.data!.id);
      if (error) throw error;
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["care-team-record", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] }); }
  });

  const availabilityMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("replace_caregiver_record_availability", { target_organization_id: activeOrganizationId!, target_caregiver_record_id: recordQuery.data!.id, availability_slots: availability.map(({ day_of_week, start_time, end_time, preference }) => ({ day_of_week, start_time, end_time, preference })) });
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["care-team-availability", activeOrganizationId, id] })
  });

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUserId) throw new Error("Choose an active account first.");
      const { error } = await supabase.rpc("link_caregiver_record_to_user", { target_organization_id: activeOrganizationId!, target_caregiver_record_id: recordQuery.data!.id, target_user_id: selectedUserId });
      if (error) throw error;
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["care-team-record", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] }); }
  });

  const credentialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("caregiver_record_credentials").insert({
        organization_id: activeOrganizationId!, caregiver_record_id: recordQuery.data!.id, credential_type: credentialType.trim(), issue_date: credentialIssue || null, expiration_date: credentialExpiration || null, does_not_expire: !credentialExpiration, verification_status: "unverified"
      });
      if (error) throw error;
    },
    onSuccess: () => { setCredentialType(""); setCredentialIssue(""); setCredentialExpiration(""); void queryClient.invalidateQueries({ queryKey: ["care-team-credentials", activeOrganizationId, id] }); }
  });

  function addSlot(day: Weekday) { if (slotsByDay[day].length < 2) setAvailability((rows) => [...rows, { day_of_week: day, start_time: "09:00", end_time: "17:00", preference: "available" }]); }
  function updateSlot(day: Weekday, index: number, patch: Partial<AvailabilityRow>) { setAvailability((rows) => { let seen = -1; return rows.map((row) => { if (row.day_of_week !== day) return row; seen += 1; return seen === index ? { ...row, ...patch } : row; }); }); }
  function removeSlot(day: Weekday, index: number) { setAvailability((rows) => { let seen = -1; return rows.filter((row) => { if (row.day_of_week !== day) return true; seen += 1; return seen !== index; }); }); }

  if (!canRead) return <Card><p className="text-sm text-slate-600">You do not have permission to view this workforce record.</p></Card>;
  if (recordQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (recordQuery.isError || !recordQuery.data) return <p className="text-sm text-red-700">Could not load this record.</p>;

  const record = recordQuery.data;
  const name = `${record.preferred_name || record.first_name} ${record.last_name}`;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <Link to="/team" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"><ArrowLeft className="h-4 w-4" />Care Team</Link>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-500">Care Team record</p><h1 className="mt-1 text-2xl font-semibold text-slate-950">{name}</h1><p className="mt-1 font-mono text-xs text-slate-400">{record.caregiver_code}</p><p className="mt-1 text-sm text-slate-500">{record.email ?? "No email"}{record.phone ? ` · ${record.phone}` : ""}</p></div><div className="flex gap-2"><StatusBadge label={title(record.status)} tone={record.status === "active" || record.status === "ready" ? "success" : "neutral"}/><StatusBadge label={record.linked_user_id ? "Login linked" : "No login"} tone={record.linked_user_id ? "success" : "neutral"}/></div></div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card><h2 className="font-semibold text-slate-950">Profile</h2><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-slate-500">Employment</dt><dd className="mt-1 font-medium text-slate-900">{record.employment_type ? title(record.employment_type) : "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Available start</dt><dd className="mt-1 font-medium text-slate-900">{record.available_start_date ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Shift range</dt><dd className="mt-1 font-medium text-slate-900">{record.min_shift_hours ?? "?"}–{record.max_shift_hours ?? "?"}h</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Max travel</dt><dd className="mt-1 font-medium text-slate-900">{record.max_travel_minutes != null ? `${record.max_travel_minutes} min` : "—"}</dd></div><div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Languages</dt><dd className="mt-1 font-medium text-slate-900">{record.languages.length ? record.languages.join(", ") : "—"}</dd></div></dl></Card>
        <Card><h2 className="font-semibold text-slate-950">Workforce settings</h2><div className="mt-4 grid gap-3"><label className="text-xs font-medium text-slate-600">Status<select disabled={!canManage} value={status} onChange={(e) => setStatus(e.target.value as WorkforceRecord["status"])} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="onboarding">Onboarding</option><option value="ready">Ready</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><label className="text-xs font-medium text-slate-600">Desired hours / week<input disabled={!canManage} type="number" min="0" max="168" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>{canManage ? <Button onClick={() => saveRecordMutation.mutate()} loading={saveRecordMutation.isPending}>Save settings</Button> : null}</div></Card>
      </div>

      <Card><h2 className="font-semibold text-slate-950">Ogevia account access</h2><p className="mt-1 text-sm text-slate-500">The workforce record remains valid without a login. To give portal access, first create or activate the person in Access, then link that account here.</p>{canManage ? <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-64 flex-1 text-xs font-medium text-slate-600">Active account<select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Select active account…</option>{(membersQuery.data ?? []).map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name} · {title(member.role)}</option>)}</select></label><Button disabled={!selectedUserId} loading={linkMutation.isPending} onClick={() => linkMutation.mutate()}>{record.linked_user_id ? "Update link" : "Link account"}</Button></div> : null}{linkMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not link that account.</p> : null}</Card>

      <Card><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-950">Availability</h2><p className="mt-1 text-sm text-slate-500">Up to two time windows per day.</p></div>{canManage ? <Button variant="secondary" onClick={() => availabilityMutation.mutate()} loading={availabilityMutation.isPending}>Save availability</Button> : null}</div><div className="mt-4 grid gap-2 md:grid-cols-2">{WEEKDAYS.map((day) => <div key={day} className="rounded-lg border border-slate-200 p-2.5"><div className="flex justify-between"><p className="text-sm font-semibold text-slate-800">{title(day)}</p>{canManage && slotsByDay[day].length < 2 ? <button type="button" onClick={() => addSlot(day)} className="text-xs font-medium text-slate-700">+ Add time</button> : null}</div>{slotsByDay[day].length === 0 ? <p className="mt-1 text-xs text-slate-400">Not recorded</p> : <div className="mt-2 space-y-2">{slotsByDay[day].map((slot,index) => <div key={`${day}-${index}`} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_1fr_auto]"><input disabled={!canManage} type="time" value={slot.start_time} onChange={(e) => updateSlot(day,index,{start_time:e.target.value})} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"/><input disabled={!canManage} type="time" value={slot.end_time} onChange={(e) => updateSlot(day,index,{end_time:e.target.value})} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"/><select disabled={!canManage} value={slot.preference} onChange={(e) => updateSlot(day,index,{preference:e.target.value as Preference})} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><option value="available">Available</option><option value="preferred">Preferred</option></select>{canManage ? <button type="button" onClick={() => removeSlot(day,index)} className="px-1 text-xs text-red-600">Remove</button> : null}</div>)}</div>}</div>)}</div>{availabilityMutation.isError ? <p className="mt-3 text-sm text-red-700">Could not save availability.</p> : null}{availabilityMutation.isSuccess ? <p className="mt-3 text-sm text-emerald-700">Availability saved.</p> : null}</Card>

      <Card><h2 className="font-semibold text-slate-950">Credentials</h2>{(credentialsQuery.data ?? []).length === 0 ? <p className="mt-3 text-sm text-slate-400">No credentials recorded.</p> : <div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-2 py-2">Credential</th><th className="px-2 py-2">Issue</th><th className="px-2 py-2">Expiration</th><th className="px-2 py-2">Verification</th></tr></thead><tbody>{(credentialsQuery.data ?? []).map((row) => <tr key={row.id} className="border-b border-slate-100"><td className="px-2 py-3 font-medium text-slate-900">{row.credential_type}</td><td className="px-2 py-3">{row.issue_date ?? "—"}</td><td className="px-2 py-3">{row.does_not_expire ? "Does not expire" : row.expiration_date ?? "—"}</td><td className="px-2 py-3"><StatusBadge label={title(row.verification_status)} tone={row.verification_status === "verified" ? "success" : "warning"}/></td></tr>)}</tbody></table></div>}{canManageCredentials ? <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3"><input placeholder="Credential type" value={credentialType} onChange={(e) => setCredentialType(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><label className="text-xs font-medium text-slate-600">Issue date<input type="date" value={credentialIssue} onChange={(e) => setCredentialIssue(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600">Expiration date<input type="date" value={credentialExpiration} onChange={(e) => setCredentialExpiration(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><div className="sm:col-span-3"><Button disabled={!credentialType.trim()} loading={credentialMutation.isPending} onClick={() => credentialMutation.mutate()}>Add credential</Button></div></div> : null}</Card>
      <Card>
        <h2 className="font-semibold text-slate-950">Client assignments</h2>
        {!record.linked_user_id ? (
          <p className="mt-3 text-sm text-slate-400">Assignments require a linked login today - link an account above to see them here.</p>
        ) : !canReadAssignments ? (
          <p className="mt-3 text-sm text-slate-400">You do not have permission to view assignments.</p>
        ) : assignmentsForRecord.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No client assignments recorded.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {assignmentsForRecord.map((row) => (
              <li key={row.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{row.client_name}</p>
                  <p className="text-xs text-slate-500">{row.service_name} · since {row.effective_start}{row.effective_end ? ` – ${row.effective_end}` : ""}</p>
                </div>
                <StatusBadge label={row.is_active ? "Active" : "Ended"} tone={row.is_active ? "success" : "neutral"} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="font-semibold text-slate-950">Visits</h2>
        {!canReadShifts ? (
          <p className="mt-3 text-sm text-slate-400">You do not have permission to view visit history.</p>
        ) : shiftsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : (shiftsQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No visits recorded.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {(shiftsQuery.data ?? []).map((row) => (
              <li key={row.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{row.client_name}</p>
                  <p className="text-xs text-slate-500">{new Date(row.starts_at).toLocaleString()} – {new Date(row.ends_at).toLocaleTimeString()}</p>
                </div>
                <StatusBadge label={title(row.status)} tone={row.status === "completed" ? "success" : row.status === "no_show" ? "danger" : "neutral"} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? <Card><h2 className="font-semibold text-slate-950">Edit workforce profile</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{([['first_name','First name'],['last_name','Last name'],['preferred_name','Preferred name'],['email','Email'],['phone','Phone'],['address_street','Street address'],['address_city','City'],['address_state','State'],['address_zip','ZIP'],['employment_type','Employment type'],['available_start_date','Available start date'],['min_weekly_hours','Minimum weekly hours'],['max_weekly_hours','Maximum weekly hours'],['min_shift_hours','Minimum shift hours'],['max_shift_hours','Maximum shift hours'],['max_travel_minutes','Maximum travel minutes'],['languages','Languages (comma separated)']] as const).map(([key,label]) => <label key={key} className="text-xs font-medium text-slate-600">{label}<input type={key === 'available_start_date' ? 'date' : key.includes('hours') || key === 'max_travel_minutes' ? 'number' : key === 'email' ? 'email' : 'text'} value={profile[key]} onChange={(event) => setProfile({ ...profile, [key]: event.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>)}</div><div className="mt-4"><Button loading={saveRecordMutation.isPending} disabled={!profile.first_name.trim() || !profile.last_name.trim()} onClick={() => saveRecordMutation.mutate()}>Save profile</Button></div></Card> : null}

      {record.applicant_id ? <><Card><h2 className="font-semibold text-slate-950">Hiring and onboarding continuity</h2><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><p><span className="text-slate-500">Onboarding:</span> {record.onboarding_status ? title(record.onboarding_status) : "—"}</p><p><span className="text-slate-500">Scheduled:</span> {record.onboarding_scheduled_at ? new Date(record.onboarding_scheduled_at).toLocaleString() : "—"}</p><p><span className="text-slate-500">Method:</span> {record.onboarding_method ? title(record.onboarding_method) : "—"}</p><p><span className="text-slate-500">Location:</span> {record.onboarding_location ?? "—"}</p><p><span className="text-slate-500">Background check:</span> {record.background_check_status ? title(record.background_check_status) : "—"}</p><p><span className="text-slate-500">Compliance:</span> {record.compliance_status ? title(record.compliance_status) : "—"}</p>{record.onboarding_instructions ? <p className="sm:col-span-2"><span className="text-slate-500">Instructions:</span> {record.onboarding_instructions}</p> : null}</div></Card><DocumentsCard organizationId={activeOrganizationId} subjectType="applicant" subjectId={record.applicant_id} subjectName={`${record.first_name} ${record.last_name}`} subjectEmail={record.email ?? undefined} canRead={canReadDocuments} canManage={canManageDocuments}/></> : null}
    </section>
  );
}
