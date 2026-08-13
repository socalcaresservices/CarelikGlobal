import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { supabase } from "@/lib/supabase";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

type Preference = "available" | "preferred";
interface AvailabilityRow { id?: string; day_of_week: Weekday; start_time: string; end_time: string; preference: Preference; }
interface CredentialRow { id?: string; credential_type: string; issue_date: string | null; expiration_date: string | null; does_not_expire: boolean; issuing_organization: string | null; credential_number: string | null; submission_status: string; verification_status: string; notes: string | null; }
interface CandidateProfile {
  id: string; first_name: string; middle_name: string | null; last_name: string; preferred_name: string | null;
  email: string; phone: string | null; alternate_phone: string | null; address_street: string | null;
  address_line2: string | null; address_city: string | null; address_state: string | null; address_zip: string | null;
  employment_type: string | null; available_start_date: string | null; desired_weekly_hours: number | null;
  min_weekly_hours: number | null; max_weekly_hours: number | null; min_shift_hours: number | null;
  max_shift_hours: number | null; max_travel_minutes: number | null; transportation_method: string | null;
  reliable_transportation: boolean | null; willing_to_transport_clients: boolean | null;
  valid_drivers_license: boolean | null; vehicle_available: boolean | null; auto_insurance: boolean | null;
  languages: string[]; position_applied_for: string | null;
}
interface PortalData {
  organization: { display_name: string; logo_url: string | null; accent_color: string | null; show_powered_by: boolean };
  candidate: CandidateProfile;
  availability: AvailabilityRow[];
  credentials: CredentialRow[];
  onboarding: { status?: string; scheduled_at?: string | null; method?: string | null; location?: string | null; instructions?: string | null } | null;
}

function label(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function timeValue(value: string) { return value?.slice(0, 5) || "09:00"; }

export function CandidatePortalPage() {
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const portalQuery = useQuery({
    queryKey: ["candidate-portal", token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_candidate_portal", { target_token: token! });
      if (error) throw error;
      return data as PortalData;
    },
    enabled: !!token,
    retry: false
  });

  const candidate = portalQuery.data?.candidate;
  const [profile, setProfile] = useState<Record<string, string | boolean>>({});
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!portalQuery.data) return;
    const c = portalQuery.data.candidate;
    setProfile({
      preferred_name: c.preferred_name ?? "", phone: c.phone ?? "", alternate_phone: c.alternate_phone ?? "",
      address_street: c.address_street ?? "", address_line2: c.address_line2 ?? "", address_city: c.address_city ?? "",
      address_state: c.address_state ?? "", address_zip: c.address_zip ?? "", employment_type: c.employment_type ?? "",
      available_start_date: c.available_start_date ?? "", desired_weekly_hours: c.desired_weekly_hours?.toString() ?? "",
      min_weekly_hours: c.min_weekly_hours?.toString() ?? "", max_weekly_hours: c.max_weekly_hours?.toString() ?? "",
      min_shift_hours: c.min_shift_hours?.toString() ?? "", max_shift_hours: c.max_shift_hours?.toString() ?? "",
      max_travel_minutes: c.max_travel_minutes?.toString() ?? "", transportation_method: c.transportation_method ?? "",
      reliable_transportation: c.reliable_transportation ?? false, willing_to_transport_clients: c.willing_to_transport_clients ?? false,
      valid_drivers_license: c.valid_drivers_license ?? false, vehicle_available: c.vehicle_available ?? false,
      auto_insurance: c.auto_insurance ?? false, languages: c.languages.join(", ")
    });
    setAvailability(portalQuery.data.availability.map((row) => ({ ...row, start_time: timeValue(row.start_time), end_time: timeValue(row.end_time) })));
    setCredentials(portalQuery.data.credentials);
  }, [portalQuery.data]);

  const slotsByDay = useMemo(() => Object.fromEntries(WEEKDAYS.map((day) => [day, availability.filter((row) => row.day_of_week === day)])) as Record<Weekday, AvailabilityRow[]>, [availability]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!token) return;
      const languages = String(profile.languages ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const payload = { ...profile, languages };
      const profileResult = await supabase.rpc("save_candidate_portal_profile", { target_token: token, profile: payload });
      if (profileResult.error) throw profileResult.error;
      const availabilityResult = await supabase.rpc("replace_candidate_portal_availability", { target_token: token, availability_rows: availability });
      if (availabilityResult.error) throw availabilityResult.error;
      const credentialPayload = credentials.map((row) => ({ ...row, id: undefined, submission_status: undefined, verification_status: undefined }));
      const credentialResult = await supabase.rpc("replace_candidate_portal_credentials", { target_token: token, credential_rows: credentialPayload });
      if (credentialResult.error) throw credentialResult.error;
    },
    onSuccess: () => { setError(null); setMessage("Your information has been saved."); void queryClient.invalidateQueries({ queryKey: ["candidate-portal", token] }); },
    onError: (cause) => { setMessage(null); setError(cause instanceof Error ? cause.message : "Could not save your information."); }
  });

  function addSlot(day: Weekday) { setAvailability((current) => [...current, { day_of_week: day, start_time: "09:00", end_time: "17:00", preference: "available" }]); }
  function updateSlot(day: Weekday, index: number, patch: Partial<AvailabilityRow>) {
    setAvailability((current) => {
      let seen = -1;
      return current.map((row) => {
        if (row.day_of_week !== day) return row;
        seen += 1;
        return seen === index ? { ...row, ...patch } : row;
      });
    });
  }
  function removeSlot(day: Weekday, index: number) {
    setAvailability((current) => { let seen = -1; return current.filter((row) => { if (row.day_of_week !== day) return true; seen += 1; return seen !== index; }); });
  }
  function copyDay(day: Weekday) {
    const source = slotsByDay[day];
    if (!source.length) return;
    setAvailability((current) => {
      const withoutWeekdays = current.filter((row) => row.day_of_week === day);
      return [...withoutWeekdays, ...WEEKDAYS.filter((target) => target !== day).flatMap((target) => source.map((slot) => {
        const copy = { ...slot, day_of_week: target };
        delete copy.id;
        return copy;
      }))];
    });
  }
  function addCredential() { setCredentials((current) => [...current, { credential_type: "", issue_date: null, expiration_date: null, does_not_expire: false, issuing_organization: null, credential_number: null, submission_status: "self_reported", verification_status: "unverified", notes: null }]); }

  function submit(event: FormEvent) { event.preventDefault(); setMessage(null); setError(null); saveMutation.mutate(); }

  if (portalQuery.isLoading) return <main className="mx-auto max-w-3xl p-6"><Card><p className="text-sm text-slate-500">Opening your secure form…</p></Card></main>;
  if (portalQuery.isError || !portalQuery.data || !candidate) return <main className="mx-auto max-w-3xl p-6"><Card><h1 className="text-xl font-semibold">This link is unavailable</h1><p className="mt-2 text-sm text-slate-600">It may have expired or been replaced. Contact the organization that sent it to you.</p></Card></main>;

  const org = portalQuery.data.organization;
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8" style={org.accent_color ? { "--color-accent": org.accent_color } as React.CSSProperties : undefined}>
      <form onSubmit={submit} className="mx-auto max-w-3xl space-y-5">
        <header className="text-center">{org.logo_url ? <img src={org.logo_url} alt={org.display_name} className="mx-auto max-h-12" /> : null}<p className="mt-2 text-sm font-medium text-slate-500">{org.display_name}</p><h1 className="mt-1 text-2xl font-semibold text-slate-950">Complete your work information</h1><p className="mt-2 text-sm text-slate-600">{candidate.first_name} {candidate.last_name}{candidate.position_applied_for ? ` · ${candidate.position_applied_for}` : ""}</p></header>

        <Card><h2 className="font-semibold text-slate-950">Contact & work preferences</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">
          <input placeholder="Preferred name" value={String(profile.preferred_name ?? "")} onChange={(e) => setProfile({ ...profile, preferred_name: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="Phone" value={String(profile.phone ?? "")} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="Address" value={String(profile.address_street ?? "")} onChange={(e) => setProfile({ ...profile, address_street: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-2" />
          <input placeholder="Apartment / unit" value={String(profile.address_line2 ?? "")} onChange={(e) => setProfile({ ...profile, address_line2: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="City" value={String(profile.address_city ?? "")} onChange={(e) => setProfile({ ...profile, address_city: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="State" value={String(profile.address_state ?? "")} onChange={(e) => setProfile({ ...profile, address_state: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="ZIP" value={String(profile.address_zip ?? "")} onChange={(e) => setProfile({ ...profile, address_zip: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <label className="text-xs font-medium text-slate-600">Available start date<input type="date" value={String(profile.available_start_date ?? "")} onChange={(e) => setProfile({ ...profile, available_start_date: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="text-xs font-medium text-slate-600">Employment preference<select value={String(profile.employment_type ?? "")} onChange={(e) => setProfile({ ...profile, employment_type: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Select…</option><option value="full_time">Full-Time</option><option value="part_time">Part-Time</option><option value="per_diem">Per Diem</option><option value="contractor">Contractor</option></select></label>
          <input type="number" min="0" max="168" step="0.5" placeholder="Desired hours / week" value={String(profile.desired_weekly_hours ?? "")} onChange={(e) => setProfile({ ...profile, desired_weekly_hours: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input type="number" min="0" placeholder="Maximum travel minutes" value={String(profile.max_travel_minutes ?? "")} onChange={(e) => setProfile({ ...profile, max_travel_minutes: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input placeholder="Languages, separated by commas" value={String(profile.languages ?? "")} onChange={(e) => setProfile({ ...profile, languages: e.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-2" />
        </div></Card>

        <Card><div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-950">Weekly availability</h2><p className="mt-1 text-xs text-slate-500">Add more than one time window on the same day when needed.</p></div></div><div className="mt-4 space-y-4">{WEEKDAYS.map((day) => <div key={day} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-800">{label(day)}</p><div className="flex gap-2"><button type="button" onClick={() => copyDay(day)} className="text-xs font-medium text-slate-500 hover:text-slate-800">Copy to week</button><button type="button" onClick={() => addSlot(day)} className="text-xs font-medium text-slate-700 hover:underline">+ Add time</button></div></div>{slotsByDay[day].length === 0 ? <p className="mt-2 text-xs text-slate-400">Not available</p> : <div className="mt-2 space-y-2">{slotsByDay[day].map((slot, index) => <div key={`${day}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"><input aria-label={`${day} start`} type="time" value={slot.start_time} onChange={(e) => updateSlot(day, index, { start_time: e.target.value })} className="rounded-lg border border-slate-200 px-2 py-2 text-sm" /><input aria-label={`${day} end`} type="time" value={slot.end_time} onChange={(e) => updateSlot(day, index, { end_time: e.target.value })} className="rounded-lg border border-slate-200 px-2 py-2 text-sm" /><select value={slot.preference} onChange={(e) => updateSlot(day, index, { preference: e.target.value as Preference })} className="rounded-lg border border-slate-200 px-2 py-2 text-sm"><option value="available">Available</option><option value="preferred">Preferred</option></select><button type="button" onClick={() => removeSlot(day, index)} className="px-2 text-sm text-red-600">Remove</button></div>)}</div>}</div>)}</div></Card>

        <Card><div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-950">Credentials & certifications</h2><p className="mt-1 text-xs text-slate-500">Enter applicable credentials. Organization staff verify them separately.</p></div><Button type="button" variant="secondary" size="sm" onClick={addCredential}>Add credential</Button></div>{credentials.length === 0 ? <p className="mt-3 text-sm text-slate-400">No credentials added.</p> : <div className="mt-4 space-y-3">{credentials.map((row, index) => <div key={row.id ?? index} className="rounded-xl border border-slate-200 p-3"><div className="grid gap-2 sm:grid-cols-2"><input placeholder="Credential type, e.g. CPR" value={row.credential_type} onChange={(e) => setCredentials((current) => current.map((item, i) => i === index ? { ...item, credential_type: e.target.value } : item))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" /><input placeholder="Issuing organization" value={row.issuing_organization ?? ""} onChange={(e) => setCredentials((current) => current.map((item, i) => i === index ? { ...item, issuing_organization: e.target.value } : item))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" /><label className="text-xs text-slate-600">Issue date<input type="date" value={row.issue_date ?? ""} onChange={(e) => setCredentials((current) => current.map((item, i) => i === index ? { ...item, issue_date: e.target.value || null } : item))} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label><label className="text-xs text-slate-600">Expiration date<input type="date" disabled={row.does_not_expire} value={row.expiration_date ?? ""} onChange={(e) => setCredentials((current) => current.map((item, i) => i === index ? { ...item, expiration_date: e.target.value || null } : item))} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50" /></label></div><div className="mt-2 flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={row.does_not_expire} onChange={(e) => setCredentials((current) => current.map((item, i) => i === index ? { ...item, does_not_expire: e.target.checked, expiration_date: e.target.checked ? null : item.expiration_date } : item))} />Does not expire</label>{row.verification_status === "verified" ? <StatusBadge label="Verified by organization" tone="success" /> : <StatusBadge label="Not yet verified" tone="neutral" />}</div></div>)}</div>}</Card>

        {portalQuery.data.onboarding?.scheduled_at ? <Card><h2 className="font-semibold text-slate-950">Onboarding</h2><p className="mt-2 text-sm text-slate-700">{new Date(portalQuery.data.onboarding.scheduled_at).toLocaleString()}</p>{portalQuery.data.onboarding.method ? <p className="mt-1 text-sm text-slate-600">{label(portalQuery.data.onboarding.method)}</p> : null}{portalQuery.data.onboarding.location ? <p className="mt-1 text-sm text-slate-600">{portalQuery.data.onboarding.location}</p> : null}{portalQuery.data.onboarding.instructions ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{portalQuery.data.onboarding.instructions}</p> : null}</Card> : null}

        {message ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p> : null}{error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <Button type="submit" loading={saveMutation.isPending} className="w-full">{saveMutation.isPending ? "Saving…" : "Save My Information"}</Button>
        {org.show_powered_by !== false ? <p className="text-center text-xs text-slate-400">Powered by Ogevia</p> : null}
      </form>
    </main>
  );
}
