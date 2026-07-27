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
// Field set matches the agency's revised spec: personal info, home
// address (used for travel-time matching later - never asked as a
// separate "preferred city" list), the agency's own configured
// services (pulled live from list_public_organization_services(), no
// hardcoded list here or in the database), weekly availability, desired
// hours, and structured yes/no travel questions in place of a free-text
// "how do you get around" field.
//
// Deliberately not on this form (see the migration's comment for why):
// a photo upload (needs its own storage-bucket subsystem) and more than
// one shift window per day (schema already supports it, UI doesn't
// expose it yet). Credentials, skills, and compliance are staff-side
// concerns that apply after hire, not at application time.

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"
];

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

interface ServiceOption {
  id: string;
  name: string;
}

interface ApplicationForm {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
  email: string;
  phone: string;
  alternatePhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  addressStreet: string;
  addressLine2: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  desiredWeeklyHours: string;
  minWeeklyHours: string;
  maxWeeklyHours: string;
  minShiftHours: string;
  maxShiftHours: string;
  maxTravelMinutes: string;
  reliableTransportation: boolean;
  willingToTransportClients: boolean;
  validDriversLicense: boolean;
  vehicleAvailable: boolean;
  autoInsurance: boolean;
  languages: string;
  notes: string;
}

const emptyForm: ApplicationForm = {
  firstName: "",
  middleName: "",
  lastName: "",
  preferredName: "",
  dateOfBirth: "",
  email: "",
  phone: "",
  alternatePhone: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  addressStreet: "",
  addressLine2: "",
  addressCity: "",
  addressState: "",
  addressZip: "",
  desiredWeeklyHours: "",
  minWeeklyHours: "",
  maxWeeklyHours: "",
  minShiftHours: "",
  maxShiftHours: "",
  maxTravelMinutes: "",
  reliableTransportation: false,
  willingToTransportClients: false,
  validDriversLicense: false,
  vehicleAvailable: false,
  autoInsurance: false,
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

  const organizationId = organizationQuery.data?.id;

  const servicesQuery = useQuery({
    queryKey: ["apply-services", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_public_organization_services", {
        target_organization_id: organizationId!
      });
      if (error) throw error;
      return (data ?? []) as ServiceOption[];
    },
    enabled: !!organizationId
  });

  const [form, setForm] = useState<ApplicationForm>(emptyForm);
  const [availability, setAvailability] = useState<Record<Weekday, DayAvailabilityForm>>(emptyAvailabilityForm());
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function updateAvailabilityDay(day: Weekday, patch: Partial<DayAvailabilityForm>) {
    setAvailability((current) => ({ ...current, [day]: { ...current[day], ...patch } }));
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId]
    );
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
        middle_name: form.middleName || null,
        last_name: form.lastName,
        preferred_name: form.preferredName || null,
        date_of_birth: form.dateOfBirth || null,
        email: form.email,
        phone: form.phone || null,
        alternate_phone: form.alternatePhone || null,
        emergency_contact_name: form.emergencyContactName || null,
        emergency_contact_phone: form.emergencyContactPhone || null,
        address_street: form.addressStreet || null,
        address_line2: form.addressLine2 || null,
        address_city: form.addressCity || null,
        address_state: form.addressState || null,
        address_zip: form.addressZip || null,
        desired_weekly_hours: parseOptionalNumber(form.desiredWeeklyHours),
        min_weekly_hours: parseOptionalNumber(form.minWeeklyHours),
        max_weekly_hours: parseOptionalNumber(form.maxWeeklyHours),
        min_shift_hours: parseOptionalNumber(form.minShiftHours),
        max_shift_hours: parseOptionalNumber(form.maxShiftHours),
        max_travel_minutes: parseOptionalNumber(form.maxTravelMinutes),
        reliable_transportation: form.reliableTransportation,
        willing_to_transport_clients: form.willingToTransportClients,
        valid_drivers_license: form.validDriversLicense,
        vehicle_available: form.vehicleAvailable,
        auto_insurance: form.autoInsurance,
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

      if (selectedServiceIds.length > 0) {
        const { error: servicesError } = await supabase.from("job_applicant_services").insert(
          selectedServiceIds.map((serviceId) => ({
            organization_id: organizationQuery.data!.id,
            applicant_id: applicantId,
            service_id: serviceId
          }))
        );
        if (servicesError) throw servicesError;
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
            <h2 className="font-semibold text-slate-950">Personal information</h2>
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
                <label htmlFor="apply-middle-name" className="block text-xs font-medium text-slate-600">
                  Middle name
                </label>
                <input
                  id="apply-middle-name"
                  value={form.middleName}
                  onChange={(event) => setForm({ ...form, middleName: event.target.value })}
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
                <label htmlFor="apply-preferred-name" className="block text-xs font-medium text-slate-600">
                  Preferred name
                </label>
                <input
                  id="apply-preferred-name"
                  value={form.preferredName}
                  onChange={(event) => setForm({ ...form, preferredName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-dob" className="block text-xs font-medium text-slate-600">
                  Date of birth
                </label>
                <input
                  id="apply-dob"
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })}
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
                  Mobile phone
                </label>
                <input
                  id="apply-phone"
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-alternate-phone" className="block text-xs font-medium text-slate-600">
                  Alternate phone
                </label>
                <input
                  id="apply-alternate-phone"
                  value={form.alternatePhone}
                  onChange={(event) => setForm({ ...form, alternatePhone: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-emergency-name" className="block text-xs font-medium text-slate-600">
                  Emergency contact
                </label>
                <input
                  id="apply-emergency-name"
                  value={form.emergencyContactName}
                  onChange={(event) => setForm({ ...form, emergencyContactName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-emergency-phone" className="block text-xs font-medium text-slate-600">
                  Emergency contact phone
                </label>
                <input
                  id="apply-emergency-phone"
                  value={form.emergencyContactPhone}
                  onChange={(event) => setForm({ ...form, emergencyContactPhone: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-950">Home address</h2>
            <p className="mt-1 text-xs text-slate-500">
              We use this to calculate travel automatically - no need to tell us which cities you prefer.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="apply-address-street" className="block text-xs font-medium text-slate-600">
                  Street address
                </label>
                <input
                  id="apply-address-street"
                  value={form.addressStreet}
                  onChange={(event) => setForm({ ...form, addressStreet: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-address-line2" className="block text-xs font-medium text-slate-600">
                  Apartment / suite
                </label>
                <input
                  id="apply-address-line2"
                  value={form.addressLine2}
                  onChange={(event) => setForm({ ...form, addressLine2: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-address-city" className="block text-xs font-medium text-slate-600">
                  City
                </label>
                <input
                  id="apply-address-city"
                  value={form.addressCity}
                  onChange={(event) => setForm({ ...form, addressCity: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="apply-address-state" className="block text-xs font-medium text-slate-600">
                  State
                </label>
                <select
                  id="apply-address-state"
                  value={form.addressState}
                  onChange={(event) => setForm({ ...form, addressState: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                >
                  <option value="">Select…</option>
                  {US_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="apply-address-zip" className="block text-xs font-medium text-slate-600">
                  ZIP code
                </label>
                <input
                  id="apply-address-zip"
                  value={form.addressZip}
                  onChange={(event) => setForm({ ...form, addressZip: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-950">Services you can provide</h2>
            {servicesQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : (servicesQuery.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">
                This agency hasn&apos;t configured any services yet.
              </p>
            ) : (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(servicesQuery.data ?? []).map((service) => (
                  <label key={service.id} className="flex items-center gap-2 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      checked={selectedServiceIds.includes(service.id)}
                      onChange={() => toggleService(service.id)}
                    />
                    {service.name}
                  </label>
                ))}
              </div>
            )}
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
            <h2 className="font-semibold text-slate-950">Desired hours</h2>
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
            <h2 className="font-semibold text-slate-950">Travel</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
              <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.reliableTransportation}
                    onChange={(event) => setForm({ ...form, reliableTransportation: event.target.checked })}
                  />
                  I have reliable transportation
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.willingToTransportClients}
                    onChange={(event) => setForm({ ...form, willingToTransportClients: event.target.checked })}
                  />
                  I can transport clients in my vehicle
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.validDriversLicense}
                    onChange={(event) => setForm({ ...form, validDriversLicense: event.target.checked })}
                  />
                  I have a valid driver&apos;s license
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.vehicleAvailable}
                    onChange={(event) => setForm({ ...form, vehicleAvailable: event.target.checked })}
                  />
                  I have a vehicle available
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.autoInsurance}
                    onChange={(event) => setForm({ ...form, autoInsurance: event.target.checked })}
                  />
                  I have auto insurance
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
