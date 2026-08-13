import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
type Preference = "available" | "preferred";
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface WorkforceRecord {
  id: string;
  applicant_id: string | null;
  linked_user_id: string | null;
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
}
interface AvailabilityRow { id?: string; day_of_week: Weekday; start_time: string; end_time: string; preference: Preference; }
interface CredentialRow { id: string; credential_type: string; issue_date: string | null; expiration_date: string | null; does_not_expire: boolean; issuing_organization: string | null; credential_number: string | null; verification_status: string; }
interface MemberRow { user_id: string; display_name: string; status: string; role: string; }

function title(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function time(value: string) { return value.slice(0, 5); }

export function WorkforceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const canRead = hasPermission("membership.read");
  const canManage = hasPermission("membership.update");
  const canManageCredentials = hasPermission("credentials.update");

  const recordQuery = useQuery({
    queryKey: ["workforce-record", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_records").select("*").eq("organization_id", activeOrganizationId!).eq("id", id!).is("deleted_at", null).single();
      if (error) throw error;
      return data as WorkforceRecord;
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const availabilityQuery = useQuery({
    queryKey: ["workforce-availability", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_record_availability").select("id, day_of_week, start_time, end_time, preference").eq("organization_id", activeOrganizationId!).eq("caregiver_record_id", id!);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const credentialsQuery = useQuery({
    queryKey: ["workforce-credentials", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_record_credentials").select("id, credential_type, issue_date, expiration_date, does_not_expire, issuing_organization, credential_number, verification_status").eq("organization_id", activeOrganizationId!).eq("caregiver_record_id", id!).is("deleted_at", null).order("credential_type");
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    },
    enabled: !!activeOrganizationId && !!id && canRead
  });

  const membersQuery = useQuery({
    queryKey: ["workforce-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", { target_organization_id: activeOrganizationId! });
      if (error) throw error;
      return ((data ?? []) as MemberRow[]).filter((row) => row.status === "active");
    },
    enabled: !!activeOrganizationId && canManage
  });

  const [status, setStatus] = useState<WorkforceRecord["status"]>("active");
  const [hours, setHours] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [credentialType, setCredentialType] = useState("");
  const [credentialIssue, setCredentialIssue] = useState("");
  const [credentialExpiration, setCredentialExpiration] = useState("");

  useEffect(() => {
    if (recordQuery.data) {
      setStatus(recordQuery.data.status);
      setHours(recordQuery.data.desired_weekly_hours?.toString() ?? "");
      setSelectedUserId(recordQuery.data.linked_user_id ?? "");
    }
  }, [recordQuery.data]);

  useEffect(() => {
    if (availabilityQuery.data) setAvailability(availabilityQuery.data.map((row) => ({ ...row, start_time: time(row.start_time), end_time: time(row.end_time) })));
  }, [availabilityQuery.data]);

  const slotsByDay = useMemo(() => Object.fromEntries(WEEKDAYS.map((day) => [day, availability.filter((row) => row.day_of_week === day)])) as Record<Weekday, AvailabilityRow[]>, [availability]);

  const saveRecordMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("caregiver_records").update({ status, desired_weekly_hours: hours ? Number(hours) : null }).eq("organization_id", activeOrganizationId!).eq("id", id!);
      if (error) throw error;
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["workforce-record", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] }); }
  });

  const availabilityMutation = useMutation({
    mutationFn: async () => {
      const del = await supabase.from("caregiver_record_availability").delete().eq("organization_id", activeOrganizationId!).eq("caregiver_record_id", id!);
      if (del.error) throw del.error;
      if (availability.length) {
        const ins = await supabase.from("caregiver_record_availability").insert(availability.map((row) => ({ organization_id: activeOrganizationId!, caregiver_record_id: id!, day_of_week: row.day_of_week, start_time: row.start_time, end_time: row.end_time, preference: row.preference })));
        if (ins.error) throw ins.error;
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["workforce-availability", activeOrganizationId, id] })
  });

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUserId) throw new Error("Choose an active account first.");
      const { error } = await supabase.rpc("link_caregiver_record_to_user", { target_organization_id: activeOrganizationId!, target_caregiver_record_id: id!, target_user_id: selectedUserId });
      if (error) throw error;
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["workforce-record", activeOrganizationId, id] }); void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] }); }
  });

  const credentialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("caregiver_record_credentials").insert({
        organization_id: activeOrganizationId!, caregiver_record_id: id!, credential_type: credentialType.trim(), issue_date: credentialIssue || null, expiration_date: credentialExpiration || null, does_not_expire: !credentialExpiration, verification_status: "unverified"
      });
      if (error) throw error;
    },
    onSuccess: () => { setCredentialType(""); setCredentialIssue(""); setCredentialExpiration(""); void queryClient.invalidateQueries({ queryKey: ["workforce-credentials", activeOrganizationId, id] }); }
  });

  function addSlot(day: Weekday) { setAvailability((rows) => [...rows, { day_of_week: day, start_time: "09:00", end_time: "17:00", preference: "available" }]); }
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
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-500">Care Team record</p><h1 className="mt-1 text-2xl font-semibold text-slate-950">{name}</h1><p className="mt-1 text-sm text-slate-500">{record.email ?? "No email"}{record.phone ? ` · ${record.phone}` : ""}</p></div><div className="flex gap-2"><StatusBadge label={title(record.status)} tone={record.status === "active" || record.status === "ready" ? "success" : "neutral"}/><StatusBadge label={record.linked_user_id ? "Login linked" : "No login"} tone={record.linked_user_id ? "success" : "neutral"}/></div></div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card><h2 className="font-semibold text-slate-950">Profile</h2><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-slate-500">Employment</dt><dd className="mt-1 font-medium text-slate-900">{record.employment_type ? title(record.employment_type) : "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Available start</dt><dd className="mt-1 font-medium text-slate-900">{record.available_start_date ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Shift range</dt><dd className="mt-1 font-medium text-slate-900">{record.min_shift_hours ?? "?"}–{record.max_shift_hours ?? "?"}h</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Max travel</dt><dd className="mt-1 font-medium text-slate-900">{record.max_travel_minutes != null ? `${record.max_travel_minutes} min` : "—"}</dd></div><div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-slate-500">Languages</dt><dd className="mt-1 font-medium text-slate-900">{record.languages.length ? record.languages.join(", ") : "—"}</dd></div></dl></Card>
        <Card><h2 className="font-semibold text-slate-950">Workforce settings</h2><div className="mt-4 grid gap-3"><label className="text-xs font-medium text-slate-600">Status<select disabled={!canManage} value={status} onChange={(e) => setStatus(e.target.value as WorkforceRecord["status"])} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="onboarding">Onboarding</option><option value="ready">Ready</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><label className="text-xs font-medium text-slate-600">Desired hours / week<input disabled={!canManage} type="number" min="0" max="168" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label>{canManage ? <Button onClick={() => saveRecordMutation.mutate()} loading={saveRecordMutation.isPending}>Save settings</Button> : null}</div></Card>
      </div>

      <Card><h2 className="font-semibold text-slate-950">Ogevia account access</h2><p className="mt-1 text-sm text-slate-500">The workforce record remains valid without a login. To give portal access, first create or activate the person in Access, then link that account here.</p>{canManage ? <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-64 flex-1 text-xs font-medium text-slate-600">Active account<select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Select active account…</option>{(membersQuery.data ?? []).map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name} · {title(member.role)}</option>)}</select></label><Button disabled={!selectedUserId} loading={linkMutation.isPending} onClick={() => linkMutation.mutate()}>{record.linked_user_id ? "Update link" : "Link account"}</Button></div> : null}{linkMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not link that account.</p> : null}</Card>

      <Card><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-950">Availability</h2><p className="mt-1 text-sm text-slate-500">Multiple time windows can be recorded for the same day.</p></div>{canManage ? <Button variant="secondary" onClick={() => availabilityMutation.mutate()} loading={availabilityMutation.isPending}>Save availability</Button> : null}</div><div className="mt-4 space-y-3">{WEEKDAYS.map((day) => <div key={day} className="rounded-lg border border-slate-200 p-3"><div className="flex justify-between"><p className="text-sm font-semibold text-slate-800">{title(day)}</p>{canManage ? <button type="button" onClick={() => addSlot(day)} className="text-xs font-medium text-slate-700">+ Add time</button> : null}</div>{slotsByDay[day].length === 0 ? <p className="mt-2 text-xs text-slate-400">Not recorded</p> : <div className="mt-2 space-y-2">{slotsByDay[day].map((slot,index) => <div key={`${day}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"><input disabled={!canManage} type="time" value={slot.start_time} onChange={(e) => updateSlot(day,index,{start_time:e.target.value})} className="rounded-lg border border-slate-200 px-2 py-2 text-sm"/><input disabled={!canManage} type="time" value={slot.end_time} onChange={(e) => updateSlot(day,index,{end_time:e.target.value})} className="rounded-lg border border-slate-200 px-2 py-2 text-sm"/><select disabled={!canManage} value={slot.preference} onChange={(e) => updateSlot(day,index,{preference:e.target.value as Preference})} className="rounded-lg border border-slate-200 px-2 py-2 text-sm"><option value="available">Available</option><option value="preferred">Preferred</option></select>{canManage ? <button type="button" onClick={() => removeSlot(day,index)} className="px-2 text-sm text-red-600">Remove</button> : null}</div>)}</div>}</div>)}</div></Card>

      <Card><h2 className="font-semibold text-slate-950">Credentials</h2>{(credentialsQuery.data ?? []).length === 0 ? <p className="mt-3 text-sm text-slate-400">No credentials recorded.</p> : <div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-2 py-2">Credential</th><th className="px-2 py-2">Issue</th><th className="px-2 py-2">Expiration</th><th className="px-2 py-2">Verification</th></tr></thead><tbody>{(credentialsQuery.data ?? []).map((row) => <tr key={row.id} className="border-b border-slate-100"><td className="px-2 py-3 font-medium text-slate-900">{row.credential_type}</td><td className="px-2 py-3">{row.issue_date ?? "—"}</td><td className="px-2 py-3">{row.does_not_expire ? "Does not expire" : row.expiration_date ?? "—"}</td><td className="px-2 py-3"><StatusBadge label={title(row.verification_status)} tone={row.verification_status === "verified" ? "success" : "warning"}/></td></tr>)}</tbody></table></div>}{canManageCredentials ? <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3"><input placeholder="Credential type" value={credentialType} onChange={(e) => setCredentialType(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><label className="text-xs font-medium text-slate-600">Issue date<input type="date" value={credentialIssue} onChange={(e) => setCredentialIssue(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-slate-600">Expiration date<input type="date" value={credentialExpiration} onChange={(e) => setCredentialExpiration(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"/></label><div className="sm:col-span-3"><Button disabled={!credentialType.trim()} loading={credentialMutation.isPending} onClick={() => credentialMutation.mutate()}>Add credential</Button></div></div> : null}</Card>
    </section>
  );
}
