import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { supabase } from "@/lib/supabase";

// Public, unauthenticated job application - no AppShell, no session
// required. Lives outside <ProtectedRoute> in App.tsx. Resolves the
// :orgSlug URL segment to an organization id via get_organization_by_slug()
// (a narrow, anon-callable RPC - see the job_applicants migration for
// why this doesn't just open organizations SELECT to anon generally).
//
// Availability capture is one window per day (available or preferred),
// same scope decision the existing caregiver_availability UI already
// made - the schema supports multiple windows per day, this first pass
// of the UI doesn't yet expose entering more than one.

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface DayAvailabilityForm {
  enabled: boolean;
  start: string;
  end: string;
  preference: "available" | "preferred";
}

function emptyAvailabilityForm(): Record<Weekday, DayAvailabilityForm> {
  return Object.fromEntries(
    WEEKDAYS.map((day) => [day, { enabled: false, start: "09:00", end: "17:00", preference: "available" as const }])
  ) as Record<Weekday, DayAvailabilityForm>;
}

interface ApplicationForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  desiredWeeklyHours: string;
  minWeeklyHours: string;
  maxWeeklyHours: string;
  minShiftHours: string;
  maxShiftHours: string;
  preferredCities: string;
  maxTravelMinutes: string;
  transportationMethod: string;
  willingToTransportClients: boolean;
  languages: string;
  notes: string;
}

const emptyForm: ApplicationForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  desiredWeeklyHours: "",
  minWeeklyHours: "",
  maxWeeklyHours: "",
  minShiftHours: "",
  maxShiftHours: "",
  preferredCities: "",
  maxTravelMinutes: "",
  transportationMethod: "",
  willingToTransportClients: false,
  languages: "",
  notes: ""
};

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function ApplyPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();

  const organizationQuery = useQuery({
    queryKey: ["apply-organization", orgSlug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_organization_by_slug", { target_slug: orgSlug! });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as { id: string; display_name: string } | null;
    },
    enabled: !!orgSlug
  });

  const [form, setForm] = useState<ApplicationForm>(emptyForm);
  const [availability, setAvailability] = useState<Record<Weekday, DayAvailabilityForm>>(emptyAvailabilityForm());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function updateAvailabilityDay(day: Weekday, patch: Partial<DayAvailabilityForm>) {
    setAvailability((current) => ({ ...current, [day]: { ...current[day], ...patch } }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationQuery.data) return;

    const enabledDays = WEEKDAYS.filter((day) => availability[day].enabled);
    const invalidDay = enabledDays.find((day) => availability[day].start >= availability[day].end);
    if (invalidDay) {
      setSubmitError(`${capitalize(invalidDay)}'s end time must be after its start time.`);
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      // Generated client-side rather than read back via `.select()`:
      // there's deliberately no public SELECT policy on job_applicants
      // (only staff with applicants.read can read applicant rows), and
      // Postgres RLS requires a satisfying SELECT policy for a plain
      // INSERT...RETURNING too, not just the INSERT policy's WITH
      // CHECK. Supplying our own id sidesteps needing to read the row
      // back at all.
      const applicantId = crypto.randomUUID();

      const { error: applicantError } = await supabase.from("job_applicants").insert({
        id: applicantId,
        organization_id: organizationQuery.data.id,
        first_name: form.firstName,
        last_name: form.lastName,
        email: form.email,
        phone: form.phone || null,
        desired_weekly_hours: parseOptionalNumber(form.desiredWeeklyHours),
        min_weekly_hours: parseOptionalNumber(form.minWeeklyHours),
        max_weekly_hours: parseOptionalNumber(form.maxWeeklyHours),
        min_shift_hours: parseOptionalNumber(form.minShiftHours),
        max_shift_hours: parseOptionalNumber(form.maxShiftHours),
        preferred_cities: parseList(form.preferredCities),
        max_travel_minutes: parseOptionalNumber(form.maxTravelMinutes),
        transportation_method: form.transportationMethod || null,
        willing_to_transport_clients: form.willingToTransportClients,
        languages: parseList(form.languages),
        notes: form.notes || null
      });
      if (applicantError) throw applicantError;

      if (enabledDays.length > 0) {
        const { error: availabilityError } = await supabase.from("job_applicant_availability").insert(
          enabledDays.map((day) => ({
            organization_id: organizationQuery.data!.id,
            applicant_id: applicantId,
            day_of_week: day,
            start_time: availability[day].start,
            end_time: availability[day].end,
            preference: availability[day].preference
          }))
        );
        if (availabilityError) throw availabilityError;
      }

      setSubmitted(true);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Could not submit your application. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!orgSlug || (!organizationQuery.isLoading && !organizationQuery.data)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold text-slate-950">Application not found</h1>
          <p className="mt-2 text-sm text-slate-600">
            This application link isn&apos;t valid. Double-check the link your recruiter sent you.
          </p>
        </Card>
      </div>
    );
  }

  if (organizationQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold text-slate-950">Thanks for applying!</h1>
          <p className="mt-2 text-sm text-slate-600">
            {organizationQuery.data?.display_name} has received your application and will reach out about
            next steps.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <p className="text-sm font-medium text-slate-500">Caregiver application</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            {organizationQuery.data?.display_name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Tell us about yourself and when you&apos;re available - we&apos;ll follow up by email or phone.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Card>
            <h2 className="font-semibold text-slate-950">About you</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="apply-first-name" className="block text-xs font-medium text-slate-600">
                  First name
                </label>
                <input
                  id="apply-first-name"
                  required
                  value={form.firstName}
                  onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-last-name" className="block text-xs font-medium text-slate-600">
                  Last name
                </label>
                <input
                  id="apply-last-name"
                  required
                  value={form.lastName}
                  onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-email" className="block text-xs font-medium text-slate-600">
                  Email
                </label>
                <input
                  id="apply-email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-phone" className="block text-xs font-medium text-slate-600">
                  Phone
                </label>
                <input
                  id="apply-phone"
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-950">Hours</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="apply-desired-hours" className="block text-xs font-medium text-slate-600">
                  Desired weekly hours
                </label>
                <input
                  id="apply-desired-hours"
                  type="number"
                  min={0}
                  max={168}
                  value={form.desiredWeeklyHours}
                  onChange={(event) => setForm({ ...form, desiredWeeklyHours: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-min-weekly-hours" className="block text-xs font-medium text-slate-600">
                  Minimum acceptable weekly hours
                </label>
                <input
                  id="apply-min-weekly-hours"
                  type="number"
                  min={0}
                  max={168}
                  value={form.minWeeklyHours}
                  onChange={(event) => setForm({ ...form, minWeeklyHours: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-max-weekly-hours" className="block text-xs font-medium text-slate-600">
                  Maximum weekly hours
                </label>
                <input
                  id="apply-max-weekly-hours"
                  type="number"
                  min={0}
                  max={168}
                  value={form.maxWeeklyHours}
                  onChange={(event) => setForm({ ...form, maxWeeklyHours: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-min-shift-hours" className="block text-xs font-medium text-slate-600">
                  Minimum shift length (hours)
                </label>
                <input
                  id="apply-min-shift-hours"
                  type="number"
                  min={0}
                  value={form.minShiftHours}
                  onChange={(event) => setForm({ ...form, minShiftHours: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-max-shift-hours" className="block text-xs font-medium text-slate-600">
                  Maximum shift length (hours)
                </label>
                <input
                  id="apply-max-shift-hours"
                  type="number"
                  min={0}
                  value={form.maxShiftHours}
                  onChange={(event) => setForm({ ...form, maxShiftHours: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-950">Weekly availability</h2>
            <p className="mt-1 text-xs text-slate-500">Check the days you can work and mark whether a day is a preference.</p>
            <div className="mt-4 space-y-2">
              {WEEKDAYS.map((day) => (
                <div key={day} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 p-2">
                  <label className="flex w-28 items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={availability[day].enabled}
                      onChange={(event) => updateAvailabilityDay(day, { enabled: event.target.checked })}
                    />
                    {capitalize(day)}
                  </label>
                  <input
                    type="time"
                    aria-label={`${capitalize(day)} start time`}
                    disabled={!availability[day].enabled}
                    value={availability[day].start}
                    onChange={(event) => updateAvailabilityDay(day, { start: event.target.value })}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900 disabled:bg-slate-50"
                  />
                  <span className="text-xs text-slate-400">to</span>
                  <input
                    type="time"
                    aria-label={`${capitalize(day)} end time`}
                    disabled={!availability[day].enabled}
                    value={availability[day].end}
                    onChange={(event) => updateAvailabilityDay(day, { end: event.target.value })}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900 disabled:bg-slate-50"
                  />
                  <select
                    aria-label={`${capitalize(day)} preference`}
                    disabled={!availability[day].enabled}
                    value={availability[day].preference}
                    onChange={(event) =>
                      updateAvailabilityDay(day, { preference: event.target.value as "available" | "preferred" })
                    }
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900 disabled:bg-slate-50"
                  >
                    <option value="available">Available</option>
                    <option value="preferred">Preferred</option>
                  </select>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-950">Travel and preferences</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="apply-preferred-cities" className="block text-xs font-medium text-slate-600">
                  Preferred cities
                </label>
                <input
                  id="apply-preferred-cities"
                  placeholder="Comma-separated, e.g. Corona, Riverside"
                  value={form.preferredCities}
                  onChange={(event) => setForm({ ...form, preferredCities: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-max-travel" className="block text-xs font-medium text-slate-600">
                  Maximum travel time (minutes)
                </label>
                <input
                  id="apply-max-travel"
                  type="number"
                  min={0}
                  value={form.maxTravelMinutes}
                  onChange={(event) => setForm({ ...form, maxTravelMinutes: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-transportation" className="block text-xs font-medium text-slate-600">
                  Transportation method
                </label>
                <input
                  id="apply-transportation"
                  placeholder="e.g. own car, public transit"
                  value={form.transportationMethod}
                  onChange={(event) => setForm({ ...form, transportationMethod: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-languages" className="block text-xs font-medium text-slate-600">
                  Languages
                </label>
                <input
                  id="apply-languages"
                  placeholder="Comma-separated, e.g. English, Spanish"
                  value={form.languages}
                  onChange={(event) => setForm({ ...form, languages: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.willingToTransportClients}
                    onChange={(event) => setForm({ ...form, willingToTransportClients: event.target.checked })}
                  />
                  I&apos;m willing to transport clients in my vehicle
                </label>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="apply-notes" className="block text-xs font-medium text-slate-600">
                  Anything else you&apos;d like us to know?
                </label>
                <textarea
                  id="apply-notes"
                  rows={3}
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </Card>

          {submitError ? <p className="text-sm text-red-700">{submitError}</p> : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit application"}
          </button>
        </form>
      </div>
    </div>
  );
}
