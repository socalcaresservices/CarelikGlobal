import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  Button,
  Card,
  MultiSelectCombobox,
  ScoreBadge,
  StatusBadge,
  UtilizationCard,
  cn,
  type ComboboxOption,
  type StatusTone
} from "@carelik/ui";
import { getCredentialStatus, type CredentialStatus } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { getWeekEnd, getWeekStart } from "@/lib/week";

// Same record layout pattern as client-detail-page.tsx: header with
// headline metrics, a KPI row for weekly hours (target/scheduled/gap),
// then tabs. Requires membership.read to view another caregiver's page
// at all - reusing the same gate AccessPage already has, since that's
// where this page is linked from.

interface MemberDetail {
  user_id: string;
  display_name: string;
  role: string;
  status: string;
}

interface ShiftRow {
  id: string;
  caregiver_user_id: string;
  client_name: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

interface CredentialRow {
  id: string;
  caregiver_user_id: string;
  credential_type: string;
  expires_at: string | null;
}

interface IncidentRow {
  id: string;
  caregiver_user_id: string | null;
  reported_by: string | null;
  occurred_at: string;
  category: string;
  status: "open" | "under_review" | "resolved";
}

interface CaregiverHoursRow {
  caregiver_user_id: string;
  target_hours_per_week: number | null;
  scheduled_hours: number;
}

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
}

interface CaregiverLocationRow {
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  languages: string[];
  skills: string[];
}

interface LookupRow {
  id: string;
  name: string;
  is_active: boolean;
}

type Tab = "overview" | "schedule" | "credentials" | "incidents" | "notes" | "history";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface AvailabilityRow {
  day_of_week: Weekday;
  start_time: string;
  end_time: string;
}

interface DayAvailabilityForm {
  enabled: boolean;
  start: string;
  end: string;
}

function emptyAvailabilityForm(): Record<Weekday, DayAvailabilityForm> {
  return Object.fromEntries(
    WEEKDAYS.map((day) => [day, { enabled: false, start: "09:00", end: "17:00" }])
  ) as Record<Weekday, DayAvailabilityForm>;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Deterministic (not random) placeholder score so the same caregiver
// shows the same sample number on every render/reload instead of
// flickering - still entirely sample data, see the ScoreBadge usage
// below and its component-level comment for why this exists at all.
function previewScoreFromId(id: string, offset: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 1000;
  }
  return 55 + ((hash + offset) % 41);
}

const credentialStatusTone: Record<CredentialStatus, StatusTone> = {
  no_expiration: "neutral",
  active: "success",
  expiring_soon: "warning",
  expired: "danger"
};

const credentialStatusLabel: Record<CredentialStatus, string> = {
  no_expiration: "No expiration",
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired"
};

export function CaregiverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");

  const canSeeMembers = hasPermission("membership.read");
  const canReadAudit = hasPermission("audit.read");
  const canEditProfile = id === user?.id || hasPermission("membership.update");
  const canManageCredentials = hasPermission("credentials.update");
  // Deliberately no self-edit carve-out (unlike canEditProfile) - these
  // are staff notes about a caregiver, not their own profile. See
  // get_caregiver_notes/set_caregiver_notes's migration comment.
  const canManageNotes = hasPermission("membership.update");

  const weekStart = getWeekStart(new Date());
  const weekEnd = getWeekEnd(weekStart);

  const membersQuery = useQuery({
    queryKey: ["caregiver-detail-member", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as MemberDetail[]).find((row) => row.user_id === id) ?? null;
    },
    enabled: !!activeOrganizationId && !!id && canSeeMembers
  });

  const hoursQuery = useQuery({
    queryKey: ["caregiver-detail-hours", activeOrganizationId, id, weekStart.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_hours", {
        target_organization_id: activeOrganizationId!,
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString()
      });
      if (error) throw error;
      return ((data ?? []) as CaregiverHoursRow[]).find((row) => row.caregiver_user_id === id) ?? null;
    },
    enabled: !!activeOrganizationId && !!id
  });

  const shiftsQuery = useQuery({
    queryKey: ["caregiver-detail-shifts", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as ShiftRow[]).filter((row) => row.caregiver_user_id === id);
    },
    enabled: !!activeOrganizationId && !!id
  });

  const credentialsQuery = useQuery({
    queryKey: ["caregiver-detail-credentials", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_credentials", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as CredentialRow[]).filter((row) => row.caregiver_user_id === id);
    },
    enabled: !!activeOrganizationId && !!id
  });

  const notesQuery = useQuery({
    queryKey: ["caregiver-detail-notes", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_notes", {
        target_organization_id: activeOrganizationId!,
        target_user_id: id!
      });
      if (error) throw error;
      // get_caregiver_notes deliberately has no self-read carve-out (see
      // its migration comment) - a null/empty result here can mean
      // either "no notes yet" or "not permitted to see notes", and the
      // UI doesn't need to distinguish those, so both render the same
      // "No notes on file." state.
      return ((data ?? [])[0] as { notes: string | null } | undefined)?.notes ?? null;
    },
    enabled: !!activeOrganizationId && !!id && canSeeMembers
  });

  const incidentsQuery = useQuery({
    queryKey: ["caregiver-detail-incidents", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as IncidentRow[]).filter(
        (row) => row.caregiver_user_id === id || row.reported_by === id
      );
    },
    enabled: !!activeOrganizationId && !!id
  });

  const auditQuery = useQuery({
    queryKey: ["caregiver-detail-audit", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as AuditRow[]).filter((row) => row.actor_user_id === id);
    },
    enabled: !!activeOrganizationId && !!id && canReadAudit
  });

  const locationQuery = useQuery({
    queryKey: ["caregiver-detail-location", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_location", {
        target_organization_id: activeOrganizationId!,
        target_user_id: id!
      });
      if (error) throw error;
      return ((data ?? [])[0] as CaregiverLocationRow | undefined) ?? null;
    },
    enabled: !!activeOrganizationId && !!id
  });

  const availabilityQuery = useQuery({
    queryKey: ["caregiver-detail-availability", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("caregiver_availability")
        .select("day_of_week, start_time, end_time")
        .eq("organization_id", activeOrganizationId!)
        .eq("caregiver_user_id", id!);
      if (error) throw error;
      return (data ?? []) as AvailabilityRow[];
    },
    enabled: !!activeOrganizationId && !!id
  });

  // Same picker-over-name-array pattern as client-detail-page.tsx's
  // language/care needs - see 20260727070000_skills_and_languages_catalog.sql.
  const skillsQuery = useQuery({
    queryKey: ["skills", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("skills")
        .select("id, name, is_active")
        .eq("organization_id", activeOrganizationId!)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as LookupRow[];
    },
    enabled: !!activeOrganizationId
  });

  const languagesQuery = useQuery({
    queryKey: ["languages", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("languages")
        .select("id, name, is_active")
        .eq("organization_id", activeOrganizationId!)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as LookupRow[];
    },
    enabled: !!activeOrganizationId
  });

  const skillOptions: ComboboxOption[] = (skillsQuery.data ?? [])
    .filter((skill) => skill.is_active)
    .map((skill) => ({ value: skill.name, label: skill.name }));

  const languageOptions: ComboboxOption[] = (languagesQuery.data ?? [])
    .filter((language) => language.is_active)
    .map((language) => ({ value: language.name, label: language.name }));

  const [profileForm, setProfileForm] = useState({
    city: "",
    state: "",
    zip: "",
    languages: [] as string[],
    skills: [] as string[]
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (locationQuery.data) {
      setProfileForm({
        city: locationQuery.data.address_city ?? "",
        state: locationQuery.data.address_state ?? "",
        zip: locationQuery.data.address_zip ?? "",
        languages: locationQuery.data.languages ?? [],
        skills: locationQuery.data.skills ?? []
      });
    }
  }, [locationQuery.data]);

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId || !id) return;

    setProfileError(null);
    setProfileSaving(true);
    try {
      const { error } = await supabase.rpc("set_caregiver_profile", {
        target_organization_id: activeOrganizationId,
        target_user_id: id,
        new_address_city: profileForm.city || null,
        new_address_state: profileForm.state || null,
        new_address_zip: profileForm.zip || null,
        new_languages: profileForm.languages,
        new_skills: profileForm.skills
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["caregiver-detail-location", activeOrganizationId, id] });
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : "Could not save profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  const [notesDraft, setNotesDraft] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  function startEditingNotes() {
    setNotesDraft(notesQuery.data ?? "");
    setNotesError(null);
    setNotesEditing(true);
  }

  async function handleSaveNotes() {
    if (!activeOrganizationId || !id) return;
    setNotesError(null);
    setNotesSaving(true);
    try {
      const { error } = await supabase.rpc("set_caregiver_notes", {
        target_organization_id: activeOrganizationId,
        target_user_id: id,
        new_notes: notesDraft.trim() || null
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["caregiver-detail-notes", activeOrganizationId, id] });
      setNotesEditing(false);
    } catch (cause) {
      setNotesError(cause instanceof Error ? cause.message : "Could not save notes.");
    } finally {
      setNotesSaving(false);
    }
  }

  const [availabilityForm, setAvailabilityForm] = useState<Record<Weekday, DayAvailabilityForm>>(
    emptyAvailabilityForm()
  );
  const [availabilitySaving, setAvailabilitySaving] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    if (availabilityQuery.data) {
      const next = emptyAvailabilityForm();
      for (const row of availabilityQuery.data) {
        next[row.day_of_week] = {
          enabled: true,
          start: row.start_time.slice(0, 5),
          end: row.end_time.slice(0, 5)
        };
      }
      setAvailabilityForm(next);
    }
  }, [availabilityQuery.data]);

  function updateAvailabilityDay(day: Weekday, patch: Partial<DayAvailabilityForm>) {
    setAvailabilityForm((current) => ({ ...current, [day]: { ...current[day], ...patch } }));
  }

  async function handleSaveAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId || !id) return;

    setAvailabilityError(null);

    const enabledDays = WEEKDAYS.filter((day) => availabilityForm[day].enabled);
    const invalidDay = enabledDays.find((day) => availabilityForm[day].start >= availabilityForm[day].end);
    if (invalidDay) {
      setAvailabilityError(`${capitalize(invalidDay)}'s end time must be after its start time.`);
      return;
    }

    setAvailabilitySaving(true);
    try {
      const { error: deleteError } = await supabase
        .from("caregiver_availability")
        .delete()
        .eq("organization_id", activeOrganizationId)
        .eq("caregiver_user_id", id);
      if (deleteError) throw deleteError;

      if (enabledDays.length > 0) {
        const { error: insertError } = await supabase.from("caregiver_availability").insert(
          enabledDays.map((day) => ({
            organization_id: activeOrganizationId,
            caregiver_user_id: id,
            day_of_week: day,
            start_time: availabilityForm[day].start,
            end_time: availabilityForm[day].end
          }))
        );
        if (insertError) throw insertError;
      }
      void queryClient.invalidateQueries({ queryKey: ["caregiver-detail-availability", activeOrganizationId, id] });
    } catch (cause) {
      setAvailabilityError(cause instanceof Error ? cause.message : "Could not save availability.");
    } finally {
      setAvailabilitySaving(false);
    }
  }

  if (!canSeeMembers) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Team member</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">You don&apos;t have permission to view team member details.</p>
        </Card>
      </section>
    );
  }

  if (membersQuery.isLoading) {
    return <p className="mx-auto max-w-4xl text-sm text-slate-500">Loading…</p>;
  }

  if (!membersQuery.data) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Team member</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not found</h2>
          <p className="mt-3 text-slate-600">This member doesn&apos;t exist in this organization.</p>
          <Link to="/access" className="mt-4 inline-block text-sm font-medium text-slate-700 hover:underline">
            Back to access
          </Link>
        </Card>
      </section>
    );
  }

  const member = membersQuery.data;
  const hours = hoursQuery.data;
  const upcomingShiftCount = (shiftsQuery.data ?? []).filter(
    (row) => row.status === "scheduled" && new Date(row.starts_at).getTime() >= Date.now()
  ).length;
  const expiringCredentialCount = (credentialsQuery.data ?? []).filter((row) => {
    const status = getCredentialStatus(row.expires_at);
    return status === "expiring_soon" || status === "expired";
  }).length;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "schedule", label: "Schedule" },
    { key: "credentials", label: "Credentials" },
    { key: "incidents", label: "Incidents" },
    ...(canSeeMembers ? [{ key: "notes" as Tab, label: "Notes" }] : []),
    ...(canReadAudit ? [{ key: "history" as Tab, label: "History" }] : [])
  ];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/access" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" />
        Access
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">{member.display_name}</h2>
            <p className="mt-1 text-sm text-slate-500">{member.role.replace(/_/g, " ")}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* CareScore/GeoScore: sample data only, per the BUILD 001.5
                design-system scope - see ScoreBadge's own comment for why
                these aren't real numbers yet. */}
            <ScoreBadge kind="care" value={previewScoreFromId(member.user_id, 0)} preview />
            <ScoreBadge kind="geo" value={previewScoreFromId(member.user_id, 17)} preview />
            <StatusBadge label={member.status} tone={member.status === "active" ? "success" : "neutral"} />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Upcoming shifts</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{upcomingShiftCount}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Credentials expiring</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{expiringCredentialCount}</p>
          </div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">This week&apos;s capacity</p>
          <UtilizationCard
            availableHours={hours?.target_hours_per_week ?? null}
            scheduledHours={hours?.scheduled_hours ?? 0}
            compact
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-1 border-t border-slate-100 pt-4">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium",
                tab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {tab === "overview" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Overview</h3>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Role</dt>
              <dd className="mt-1 text-sm text-slate-700">{member.role.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</dt>
              <dd className="mt-1 text-sm text-slate-700">{member.status}</dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-slate-100 pt-6">
            <h4 className="text-sm font-semibold text-slate-950">Location, languages &amp; skills</h4>
            <p className="mt-1 text-xs text-slate-500">
              Used for CareScore - the client/caregiver match score shown when scheduling. See{" "}
              <Link to="/schedule" className="underline">
                Schedule
              </Link>
              .
            </p>
            {canEditProfile ? (
              <form onSubmit={handleSaveProfile} className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="caregiver-city" className="block text-xs font-medium text-slate-600">
                    City
                  </label>
                  <input
                    id="caregiver-city"
                    value={profileForm.city}
                    onChange={(event) => setProfileForm({ ...profileForm, city: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="caregiver-state" className="block text-xs font-medium text-slate-600">
                      State
                    </label>
                    <input
                      id="caregiver-state"
                      value={profileForm.state}
                      onChange={(event) => setProfileForm({ ...profileForm, state: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label htmlFor="caregiver-zip" className="block text-xs font-medium text-slate-600">
                      ZIP
                    </label>
                    <input
                      id="caregiver-zip"
                      value={profileForm.zip}
                      onChange={(event) => setProfileForm({ ...profileForm, zip: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                </div>
                <div>
                  <MultiSelectCombobox
                    label="Languages"
                    values={profileForm.languages}
                    onChange={(values) => setProfileForm({ ...profileForm, languages: values })}
                    options={languageOptions}
                    placeholder="Search languages…"
                  />
                </div>
                <div>
                  <MultiSelectCombobox
                    label="Skills"
                    values={profileForm.skills}
                    onChange={(values) => setProfileForm({ ...profileForm, skills: values })}
                    options={skillOptions}
                    placeholder="Search skills…"
                  />
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={profileSaving}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {profileSaving ? "Saving…" : "Save"}
                  </button>
                </div>
                {profileError ? <p className="text-sm text-red-700 sm:col-span-2">{profileError}</p> : null}
              </form>
            ) : (
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Location</dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {[locationQuery.data?.address_city, locationQuery.data?.address_state]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Languages</dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {(locationQuery.data?.languages ?? []).join(", ") || "—"}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Skills</dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {(locationQuery.data?.skills ?? []).join(", ") || "—"}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <div className="mt-6 border-t border-slate-100 pt-6">
            <h4 className="text-sm font-semibold text-slate-950">Weekly availability</h4>
            <p className="mt-1 text-xs text-slate-500">Which days this caregiver can work, and what hours.</p>
            {canEditProfile ? (
              <form onSubmit={handleSaveAvailability} className="mt-4 space-y-2">
                {WEEKDAYS.map((day) => (
                  <div key={day} className="flex flex-wrap items-center gap-3">
                    <label className="flex w-32 items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={availabilityForm[day].enabled}
                        onChange={(event) => updateAvailabilityDay(day, { enabled: event.target.checked })}
                      />
                      {capitalize(day)}
                    </label>
                    <input
                      type="time"
                      aria-label={`${capitalize(day)} start time`}
                      disabled={!availabilityForm[day].enabled}
                      value={availabilityForm[day].start}
                      onChange={(event) => updateAvailabilityDay(day, { start: event.target.value })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-900 disabled:opacity-50"
                    />
                    <span className="text-sm text-slate-400">to</span>
                    <input
                      type="time"
                      aria-label={`${capitalize(day)} end time`}
                      disabled={!availabilityForm[day].enabled}
                      value={availabilityForm[day].end}
                      onChange={(event) => updateAvailabilityDay(day, { end: event.target.value })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-900 disabled:opacity-50"
                    />
                  </div>
                ))}
                <div>
                  <button
                    type="submit"
                    disabled={availabilitySaving}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {availabilitySaving ? "Saving…" : "Save availability"}
                  </button>
                </div>
                {availabilityError ? <p className="text-sm text-red-700">{availabilityError}</p> : null}
              </form>
            ) : (availabilityQuery.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No availability set.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {WEEKDAYS.filter((day) => (availabilityQuery.data ?? []).some((row) => row.day_of_week === day)).map(
                  (day) => {
                    const row = availabilityQuery.data!.find((candidate) => candidate.day_of_week === day)!;
                    return (
                      <li key={day} className="flex items-center justify-between py-2 text-sm">
                        <span className="text-slate-700">{capitalize(day)}</span>
                        <span className="text-slate-500">
                          {row.start_time.slice(0, 5)} – {row.end_time.slice(0, 5)}
                        </span>
                      </li>
                    );
                  }
                )}
              </ul>
            )}
          </div>
        </Card>
      ) : null}

      {tab === "schedule" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Shifts</h3>
          {shiftsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : shiftsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load shifts for this caregiver.</p>
          ) : (shiftsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No shifts for this caregiver.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(shiftsQuery.data ?? [])
                .slice()
                .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())
                .map((shift) => (
                  <li key={shift.id} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-slate-700">
                      {new Date(shift.starts_at).toLocaleString()} – {new Date(shift.ends_at).toLocaleTimeString()}
                    </span>
                    <span className="text-slate-500">{shift.client_name}</span>
                    <span className="text-xs font-medium text-slate-500">{shift.status.replace("_", " ")}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "credentials" ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-950">Credentials</h3>
            {canManageCredentials ? (
              <Link
                to={`/credentials?caregiverId=${id}`}
                className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                Add credential for this caregiver
              </Link>
            ) : null}
          </div>
          {credentialsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : credentialsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load credentials for this caregiver.</p>
          ) : (credentialsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No credentials tracked yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(credentialsQuery.data ?? []).map((row) => {
                const status = getCredentialStatus(row.expires_at);
                return (
                  <li key={row.id} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-slate-700">{row.credential_type}</span>
                    <span className="flex items-center gap-2">
                      {row.expires_at ? (
                        <span className="text-slate-500">{new Date(row.expires_at).toLocaleDateString()}</span>
                      ) : null}
                      <StatusBadge label={credentialStatusLabel[status]} tone={credentialStatusTone[status]} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "incidents" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Incidents</h3>
          {incidentsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : incidentsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load incidents involving this caregiver.</p>
          ) : (incidentsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No incidents involving this caregiver.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(incidentsQuery.data ?? []).map((row) => (
                <li key={row.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-slate-700">{row.category}</span>
                  <span className="text-slate-500">{new Date(row.occurred_at).toLocaleDateString()}</span>
                  <span className="text-xs font-medium text-slate-500">{row.status.replace("_", " ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "notes" && canSeeMembers ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-950">Notes</h3>
            {canManageNotes && !notesEditing ? (
              <Button variant="secondary" size="sm" onClick={startEditingNotes}>
                Edit
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Internal notes staff keep about this caregiver - not visible to the caregiver themselves.
          </p>

          {notesQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : notesQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load notes for this caregiver.</p>
          ) : notesEditing ? (
            <div className="mt-3 space-y-3">
              <textarea
                rows={6}
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
              {notesError ? <p className="text-sm text-red-700">{notesError}</p> : null}
              <div className="flex items-center gap-3">
                <Button size="sm" loading={notesSaving} onClick={handleSaveNotes}>
                  Save notes
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={notesSaving}
                  onClick={() => {
                    setNotesEditing(false);
                    setNotesError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">
              {notesQuery.data ?? "No notes on file."}
            </p>
          )}
        </Card>
      ) : null}

      {tab === "history" && canReadAudit ? (
        <Card>
          <h3 className="font-semibold text-slate-950">History</h3>
          <p className="mt-1 text-xs text-slate-500">Actions this member has taken in the organization.</p>
          {auditQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : auditQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load history for this caregiver.</p>
          ) : (auditQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No recorded actions yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(auditQuery.data ?? []).map((row) => (
                <li key={row.id} className="py-2.5 text-sm">
                  <span className="text-slate-700">
                    {row.action} on {row.entity_type}
                  </span>{" "}
                  <span className="text-xs text-slate-400">{new Date(row.occurred_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </section>
  );
}
