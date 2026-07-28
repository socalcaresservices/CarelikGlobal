import { useEffect, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import type { EmploymentType } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

// Public, unauthenticated job application - no AppShell, no session
// required. Lives outside <ProtectedRoute> in App.tsx. Resolves the
// :orgSlug URL segment to an organization id via get_organization_by_slug()
// (a narrow, anon-callable RPC - see the job_applicants migration for
// why this doesn't just open organizations SELECT to anon generally).
//
// Guided multi-step wizard (Welcome -> Personal -> Address -> Employment
// preferences -> Services -> Availability -> Transportation ->
// Requirements -> Review) rather than one long scrolling form - each
// step validates before advancing, and Review lets the applicant jump
// back to fix anything before the one real submit action. Progress
// autosaves to this browser's localStorage as they go (keyed by org
// slug) so a refresh or an accidental tab close doesn't lose their
// answers; there's deliberately no cross-device "resume by email" yet -
// that needs its own auth/security design (a magic link tied to a draft
// record) and is tracked as follow-up work, not built here.
//
// Services are pulled live from list_public_organization_services() -
// never hardcoded - so adding a new service in Settings shows up here
// with no code change.
//
// Deliberately not on this form yet (each needs its own subsystem,
// tracked as follow-up, not silently dropped):
//   - Photo upload and full document upload - needs an anon-writable
//     storage bucket with real security review (file type/size limits,
//     retention), not just a column.
//   - Configurable Skills tags and full Credentials (uploaded docs,
//     per-agency credential list) - Requirements below only captures
//     the two dates and one consent an agency needs before it can even
//     schedule an interview; the rest is a staff-side concern.
//   - Gender - the app's own design-system notes flagged optional
//     demographic fields on this form as legal risk when Build 002 was
//     scoped; that call still stands unless you want it reopened.

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"
];

const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "per_diem", "contractor"];
const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-Time",
  part_time: "Part-Time",
  per_diem: "Per Diem",
  contractor: "Contractor"
};

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface ShiftBlock {
  key: string;
  start: string;
  end: string;
  preference: "available" | "preferred";
}

interface DayAvailabilityForm {
  enabled: boolean;
  shifts: ShiftBlock[];
}

function emptyShift(): ShiftBlock {
  return { key: crypto.randomUUID(), start: "09:00", end: "17:00", preference: "available" };
}

function emptyAvailabilityForm(): Record<Weekday, DayAvailabilityForm> {
  return Object.fromEntries(WEEKDAYS.map((day) => [day, { enabled: false, shifts: [emptyShift()] }])) as Record<
    Weekday,
    DayAvailabilityForm
  >;
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
  employmentType: EmploymentType | "";
  availableStartDate: string;
  desiredWeeklyHours: string;
  minWeeklyHours: string;
  maxWeeklyHours: string;
  desiredMonthlyHours: string;
  minMonthlyHours: string;
  maxMonthlyHours: string;
  minShiftHours: string;
  maxShiftHours: string;
  maxTravelMinutes: string;
  reliableTransportation: boolean;
  willingToTransportClients: boolean;
  validDriversLicense: boolean;
  vehicleAvailable: boolean;
  autoInsurance: boolean;
  tbTestExpiresAt: string;
  cprExpiresAt: string;
  backgroundCheckConsent: boolean;
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
  employmentType: "",
  availableStartDate: "",
  desiredWeeklyHours: "",
  minWeeklyHours: "",
  maxWeeklyHours: "",
  desiredMonthlyHours: "",
  minMonthlyHours: "",
  maxMonthlyHours: "",
  minShiftHours: "",
  maxShiftHours: "",
  maxTravelMinutes: "",
  reliableTransportation: false,
  willingToTransportClients: false,
  validDriversLicense: false,
  vehicleAvailable: false,
  autoInsurance: false,
  tbTestExpiresAt: "",
  cprExpiresAt: "",
  backgroundCheckConsent: false,
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

const STEP_IDS = [
  "personal",
  "address",
  "employment",
  "services",
  "availability",
  "transportation",
  "requirements",
  "review"
] as const;
type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  personal: "Personal information",
  address: "Home address",
  employment: "Employment preferences",
  services: "Services",
  availability: "Availability",
  transportation: "Transportation",
  requirements: "Requirements",
  review: "Review"
};

interface Draft {
  form: ApplicationForm;
  availability: Record<Weekday, DayAvailabilityForm>;
  selectedServiceIds: string[];
  stepIndex: number;
}

function draftKeyFor(orgSlug: string | undefined) {
  return orgSlug ? `carelik-apply-draft:${orgSlug}` : null;
}

function loadDraft(orgSlug: string | undefined): Draft | null {
  const key = draftKeyFor(orgSlug);
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}

interface ApplyOrganization {
  id: string;
  display_name: string;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  show_powered_by: boolean;
}

// Mirrors app-shell.tsx's showPoweredBy check for signed-in users -
// defaults to shown, since an organization opts OUT of platform
// attribution rather than opting in (see the show_powered_by column's
// own comment, 20260728020000). Applied here so the toggle actually
// works on the two pages a job applicant or client ever sees, which
// app-shell.tsx alone never covered.
function PoweredByFooter({ show }: { show: boolean | undefined }) {
  if (show === false) return null;
  return <p className="mt-4 text-center text-xs text-slate-400">Powered by CareLik</p>;
}

// CSS custom properties aren't part of React's CSSProperties type, so this
// narrow helper is the one place that needs the cast. Scoping --color-accent
// here (rather than editing each of the six existing var(--color-accent)
// call sites) means this organization's brand color flows through the
// Continue/Start/Submit/Next buttons and the progress bar for free the
// moment it's set in organizations-page.tsx - see the Build 023 migration
// comment for why accent_color specifically, not primary_color.
function brandStyle(accentColor: string | null | undefined): CSSProperties {
  if (!accentColor) return {};
  return { "--color-accent": accentColor, "--color-accent-foreground": "#ffffff" } as CSSProperties;
}

export function ApplyPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();

  const organizationQuery = useQuery({
    queryKey: ["apply-organization", orgSlug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_organization_by_slug", { target_slug: orgSlug! });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as ApplyOrganization | null;
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

  const [hasDraft] = useState<boolean>(() => loadDraft(orgSlug) !== null);
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState<number>(() => loadDraft(orgSlug)?.stepIndex ?? 0);
  const [form, setForm] = useState<ApplicationForm>(() => loadDraft(orgSlug)?.form ?? emptyForm);
  const [availability, setAvailability] = useState<Record<Weekday, DayAvailabilityForm>>(
    () => loadDraft(orgSlug)?.availability ?? emptyAvailabilityForm()
  );
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(
    () => loadDraft(orgSlug)?.selectedServiceIds ?? []
  );
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const key = draftKeyFor(orgSlug);
    if (!key || !started) return;
    const draft: Draft = { form, availability, selectedServiceIds, stepIndex };
    try {
      window.localStorage.setItem(key, JSON.stringify(draft));
    } catch {
      // Autosave is a convenience, not the critical path - ignore storage
      // errors (private browsing, quota, etc.) rather than blocking typing.
    }
  }, [orgSlug, started, form, availability, selectedServiceIds, stepIndex]);

  function clearDraft() {
    const key = draftKeyFor(orgSlug);
    if (!key) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // best effort
    }
  }

  function handleStartFresh() {
    setForm(emptyForm);
    setAvailability(emptyAvailabilityForm());
    setSelectedServiceIds([]);
    setStepIndex(0);
    clearDraft();
    setStarted(true);
  }

  function handleContinue() {
    setStarted(true);
  }

  function setDayEnabled(day: Weekday, enabled: boolean) {
    setAvailability((current) => ({ ...current, [day]: { ...current[day], enabled } }));
  }

  function addShift(day: Weekday) {
    setAvailability((current) => ({
      ...current,
      [day]: { ...current[day], shifts: [...current[day].shifts, emptyShift()] }
    }));
  }

  function removeShift(day: Weekday, shiftKey: string) {
    setAvailability((current) => ({
      ...current,
      [day]: { ...current[day], shifts: current[day].shifts.filter((shift) => shift.key !== shiftKey) }
    }));
  }

  function updateShift(day: Weekday, shiftKey: string, patch: Partial<ShiftBlock>) {
    setAvailability((current) => ({
      ...current,
      [day]: {
        ...current[day],
        shifts: current[day].shifts.map((shift) => (shift.key === shiftKey ? { ...shift, ...patch } : shift))
      }
    }));
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId]
    );
  }

  function validatePersonal(): string | null {
    if (!form.firstName.trim()) return "First name is required.";
    if (!form.lastName.trim()) return "Last name is required.";
    if (!form.email.trim()) return "Email is required.";
    return null;
  }

  function validateEmployment(): string | null {
    if (!form.employmentType) return "Select the employment type you're looking for.";
    return null;
  }

  function validateAvailability(): string | null {
    for (const day of WEEKDAYS) {
      if (!availability[day].enabled) continue;
      if (availability[day].shifts.length === 0) {
        return `Add at least one shift for ${capitalize(day)}, or uncheck the day.`;
      }
      const invalidShift = availability[day].shifts.find((shift) => shift.start >= shift.end);
      if (invalidShift) {
        return `${capitalize(day)}'s end time must be after its start time for every shift.`;
      }
    }
    return null;
  }

  function validateRequirements(): string | null {
    if (!form.backgroundCheckConsent) {
      return "Please confirm you're willing to undergo a background check to continue.";
    }
    return null;
  }

  function validateStep(step: StepId): string | null {
    switch (step) {
      case "personal":
        return validatePersonal();
      case "employment":
        return validateEmployment();
      case "availability":
        return validateAvailability();
      case "requirements":
        return validateRequirements();
      default:
        return null;
    }
  }

  function goToStep(step: StepId) {
    setStepError(null);
    setStepIndex(STEP_IDS.indexOf(step));
  }

  function goNext() {
    const error = validateStep(STEP_IDS[stepIndex]!);
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    setStepIndex((index) => Math.min(index + 1, STEP_IDS.length - 1));
  }

  function goPrevious() {
    setStepError(null);
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  async function handleFinalSubmit() {
    if (!organizationQuery.data) return;

    for (const step of ["personal", "employment", "availability", "requirements"] as const) {
      const error = validateStep(step);
      if (error) {
        goToStep(step);
        setStepError(error);
        return;
      }
    }

    setStepError(null);
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
        employment_type: form.employmentType || null,
        available_start_date: form.availableStartDate || null,
        desired_weekly_hours: parseOptionalNumber(form.desiredWeeklyHours),
        min_weekly_hours: parseOptionalNumber(form.minWeeklyHours),
        max_weekly_hours: parseOptionalNumber(form.maxWeeklyHours),
        desired_monthly_hours: parseOptionalNumber(form.desiredMonthlyHours),
        min_monthly_hours: parseOptionalNumber(form.minMonthlyHours),
        max_monthly_hours: parseOptionalNumber(form.maxMonthlyHours),
        min_shift_hours: parseOptionalNumber(form.minShiftHours),
        max_shift_hours: parseOptionalNumber(form.maxShiftHours),
        max_travel_minutes: parseOptionalNumber(form.maxTravelMinutes),
        reliable_transportation: form.reliableTransportation,
        willing_to_transport_clients: form.willingToTransportClients,
        valid_drivers_license: form.validDriversLicense,
        vehicle_available: form.vehicleAvailable,
        auto_insurance: form.autoInsurance,
        tb_test_expires_at: form.tbTestExpiresAt || null,
        cpr_expires_at: form.cprExpiresAt || null,
        background_check_consent: form.backgroundCheckConsent,
        languages: parseList(form.languages),
        notes: form.notes || null
      });
      if (applicantError) throw applicantError;

      const enabledDays = WEEKDAYS.filter((day) => availability[day].enabled);
      const availabilityRows = enabledDays.flatMap((day) =>
        availability[day].shifts.map((shift) => ({
          organization_id: organizationQuery.data!.id,
          applicant_id: applicantId,
          day_of_week: day,
          start_time: shift.start,
          end_time: shift.end,
          preference: shift.preference
        }))
      );
      if (availabilityRows.length > 0) {
        const { error: availabilityError } = await supabase
          .from("job_applicant_availability")
          .insert(availabilityRows);
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

      clearDraft();
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
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50 px-4"
        style={brandStyle(organizationQuery.data?.accent_color)}
      >
        <Card className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold text-slate-950">Thanks for applying!</h1>
          <p className="mt-2 text-sm text-slate-600">
            {organizationQuery.data?.display_name} has received your application and will reach out about
            next steps.
          </p>
        </Card>
        <PoweredByFooter show={organizationQuery.data?.show_powered_by} />
      </div>
    );
  }

  if (!started) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50 px-4"
        style={brandStyle(organizationQuery.data?.accent_color)}
      >
        <Card className="w-full max-w-md text-center">
          {organizationQuery.data?.logo_url ? (
            <img
              src={organizationQuery.data.logo_url}
              alt={organizationQuery.data.display_name}
              className="mx-auto max-h-12 max-w-full object-contain"
            />
          ) : (
            <p className="text-sm font-medium text-slate-500">{organizationQuery.data?.display_name}</p>
          )}
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Join Our Care Team</h1>
          <p className="mt-3 text-sm text-slate-600">
            Tell us about yourself, your availability, and what you&apos;re looking for - we&apos;ll follow up by
            email or phone.
          </p>
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">
            Approximately 6–8 minutes
          </p>
          {hasDraft ? (
            <div className="mt-6 space-y-2">
              <button
                type="button"
                onClick={handleContinue}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition"
                style={{ backgroundColor: "var(--color-accent)" }}
              >
                Continue application
              </button>
              <button
                type="button"
                onClick={handleStartFresh}
                className="w-full rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Start over
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleStartFresh}
              className="mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition"
              style={{ backgroundColor: "var(--color-accent)" }}
            >
              Start Application
            </button>
          )}
          <p className="mt-4 text-xs text-slate-400">
            Your progress is saved automatically in this browser, so you can pick up where you left off.
          </p>
        </Card>
        <PoweredByFooter show={organizationQuery.data?.show_powered_by} />
      </div>
    );
  }

  // stepIndex is always clamped to [0, STEP_IDS.length - 1] by goNext/
  // goPrevious/goToStep, so this index access is always in bounds.
  const currentStep = STEP_IDS[stepIndex]!;
  const currentStepNumber = stepIndex + 1;
  const totalSteps = STEP_IDS.length;
  const progressPct = Math.round((currentStepNumber / totalSteps) * 100);
  const selectedServices = (servicesQuery.data ?? []).filter((service) => selectedServiceIds.includes(service.id));

  return (
    <div className="min-h-screen bg-slate-50 pb-28" style={brandStyle(organizationQuery.data?.accent_color)}>
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>
              Step {currentStepNumber} of {totalSteps} · {STEP_LABELS[currentStep]}
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progressPct}%`, backgroundColor: "var(--color-accent)" }}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="space-y-6" role="group" aria-label={STEP_LABELS[currentStep]}>
          {currentStep === "personal" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Personal information</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="apply-first-name" className="block text-xs font-medium text-slate-600">
                    First name
                  </label>
                  <input
                    id="apply-first-name"
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
                  <label htmlFor="apply-languages" className="block text-xs font-medium text-slate-600">
                    Languages spoken
                  </label>
                  <input
                    id="apply-languages"
                    placeholder="Comma-separated, e.g. English, Spanish"
                    value={form.languages}
                    onChange={(event) => setForm({ ...form, languages: event.target.value })}
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
          ) : null}

          {currentStep === "address" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Home address</h2>
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
          ) : null}

          {currentStep === "employment" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Employment preferences</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="apply-employment-type" className="block text-xs font-medium text-slate-600">
                    Employment type
                  </label>
                  <select
                    id="apply-employment-type"
                    value={form.employmentType}
                    onChange={(event) =>
                      setForm({ ...form, employmentType: event.target.value as EmploymentType | "" })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">Select…</option>
                    {EMPLOYMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {EMPLOYMENT_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="apply-start-date" className="block text-xs font-medium text-slate-600">
                    Available start date
                  </label>
                  <input
                    id="apply-start-date"
                    type="date"
                    value={form.availableStartDate}
                    onChange={(event) => setForm({ ...form, availableStartDate: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
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
                  <label htmlFor="apply-desired-monthly-hours" className="block text-xs font-medium text-slate-600">
                    Desired monthly hours
                  </label>
                  <input
                    id="apply-desired-monthly-hours"
                    type="number"
                    min={0}
                    max={744}
                    value={form.desiredMonthlyHours}
                    onChange={(event) => setForm({ ...form, desiredMonthlyHours: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="apply-min-weekly-hours" className="block text-xs font-medium text-slate-600">
                    Minimum weekly hours
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
                  <label htmlFor="apply-max-monthly-hours" className="block text-xs font-medium text-slate-600">
                    Maximum monthly hours
                  </label>
                  <input
                    id="apply-max-monthly-hours"
                    type="number"
                    min={0}
                    max={744}
                    value={form.maxMonthlyHours}
                    onChange={(event) => setForm({ ...form, maxMonthlyHours: event.target.value })}
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
          ) : null}

          {currentStep === "services" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Services you can provide</h2>
              <p className="mt-1 text-xs text-slate-500">Select all that apply.</p>
              {servicesQuery.isLoading ? (
                <p className="mt-3 text-sm text-slate-500">Loading…</p>
              ) : (servicesQuery.data ?? []).length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">This agency hasn&apos;t configured any services yet.</p>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {(servicesQuery.data ?? []).map((service) => {
                    const selected = selectedServiceIds.includes(service.id);
                    return (
                      <button
                        key={service.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleService(service.id)}
                        className={`rounded-xl border px-4 py-3 text-left text-sm font-medium transition ${
                          selected
                            ? "border-transparent text-white shadow-sm"
                            : "border-slate-200 bg-white text-slate-800 hover:border-slate-300"
                        }`}
                        style={selected ? { backgroundColor: "var(--color-accent)" } : undefined}
                      >
                        {service.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
          ) : null}

          {currentStep === "availability" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Weekly availability</h2>
              <p className="mt-1 text-xs text-slate-500">
                Check the days you can work. Add more than one shift on a day if your schedule is split - e.g.
                9am–12pm and 7pm–11pm.
              </p>
              <div className="mt-4 space-y-2">
                {WEEKDAYS.map((day) => (
                  <div key={day} className="rounded-lg border border-slate-100 p-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={availability[day].enabled}
                        onChange={(event) => setDayEnabled(day, event.target.checked)}
                      />
                      {capitalize(day)}
                    </label>
                    {availability[day].enabled ? (
                      <div className="mt-2 space-y-2 pl-6">
                        {availability[day].shifts.map((shift, index) => (
                          <div key={shift.key} className="flex flex-wrap items-center gap-3">
                            <input
                              type="time"
                              aria-label={`${capitalize(day)} shift ${index + 1} start time`}
                              value={shift.start}
                              onChange={(event) => updateShift(day, shift.key, { start: event.target.value })}
                              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                            />
                            <span className="text-xs text-slate-400">to</span>
                            <input
                              type="time"
                              aria-label={`${capitalize(day)} shift ${index + 1} end time`}
                              value={shift.end}
                              onChange={(event) => updateShift(day, shift.key, { end: event.target.value })}
                              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                            />
                            <select
                              aria-label={`${capitalize(day)} shift ${index + 1} preference`}
                              value={shift.preference}
                              onChange={(event) =>
                                updateShift(day, shift.key, {
                                  preference: event.target.value as "available" | "preferred"
                                })
                              }
                              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                            >
                              <option value="available">Available</option>
                              <option value="preferred">Preferred</option>
                            </select>
                            {availability[day].shifts.length > 1 ? (
                              <button
                                type="button"
                                onClick={() => removeShift(day, shift.key)}
                                className="text-xs font-medium text-red-700 underline-offset-2 hover:underline"
                              >
                                Remove shift
                              </button>
                            ) : null}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => addShift(day)}
                          className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                        >
                          + Add another shift on {capitalize(day)}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {currentStep === "transportation" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">
                Transportation <span className="font-normal text-slate-400">(optional)</span>
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Answer what applies to you today - it&apos;s fine to leave any of this unchecked.
              </p>
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
          ) : null}

          {currentStep === "requirements" ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-950">Requirements</h2>
              <p className="mt-1 text-xs text-slate-500">
                If you already hold a current TB test or CPR certification, let us know when it expires. It&apos;s
                okay to leave these blank if you don&apos;t have them yet.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="apply-tb-expires" className="block text-xs font-medium text-slate-600">
                    TB test expiration date
                  </label>
                  <input
                    id="apply-tb-expires"
                    type="date"
                    value={form.tbTestExpiresAt}
                    onChange={(event) => setForm({ ...form, tbTestExpiresAt: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="apply-cpr-expires" className="block text-xs font-medium text-slate-600">
                    CPR expiration date
                  </label>
                  <input
                    id="apply-cpr-expires"
                    type="date"
                    value={form.cprExpiresAt}
                    onChange={(event) => setForm({ ...form, cprExpiresAt: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      checked={form.backgroundCheckConsent}
                      onChange={(event) => setForm({ ...form, backgroundCheckConsent: event.target.checked })}
                    />
                    I am willing to undergo a background check
                  </label>
                </div>
              </div>
            </Card>
          ) : null}

          {currentStep === "review" ? (
            <div className="space-y-4">
              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Personal information</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("personal")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {form.preferredName || form.firstName} {form.lastName}
                  {form.preferredName ? ` (${form.firstName} ${form.lastName})` : ""}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  {form.email || "—"}
                  {form.phone ? ` · ${form.phone}` : ""}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Home address</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("address")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {[form.addressStreet, form.addressCity, form.addressState, form.addressZip]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Employment preferences</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("employment")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {form.employmentType ? EMPLOYMENT_TYPE_LABELS[form.employmentType] : "—"}
                  {form.availableStartDate ? ` · Available ${form.availableStartDate}` : ""}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  {form.desiredWeeklyHours ? `${form.desiredWeeklyHours}h/week desired` : "No weekly-hour preference given"}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Services</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("services")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {selectedServices.length > 0 ? selectedServices.map((service) => service.name).join(", ") : "—"}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Availability</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("availability")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                {WEEKDAYS.some((day) => availability[day].enabled) ? (
                  <div className="mt-2 space-y-1 text-sm text-slate-700">
                    {WEEKDAYS.filter((day) => availability[day].enabled).map((day) => (
                      <p key={day}>
                        {capitalize(day)}:{" "}
                        {availability[day].shifts.map((shift) => `${shift.start}–${shift.end}`).join(", ")}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No availability entered.</p>
                )}
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Transportation</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("transportation")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {[
                    form.reliableTransportation ? "Reliable transportation" : null,
                    form.willingToTransportClients ? "Can transport clients" : null,
                    form.validDriversLicense ? "Valid driver's license" : null,
                    form.vehicleAvailable ? "Vehicle available" : null,
                    form.autoInsurance ? "Auto insurance" : null
                  ]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-950">Requirements</h2>
                  <button
                    type="button"
                    onClick={() => goToStep("requirements")}
                    className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  TB test: {form.tbTestExpiresAt || "—"} · CPR: {form.cprExpiresAt || "—"}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  {form.backgroundCheckConsent
                    ? "Willing to undergo a background check"
                    : "Background check consent not yet given"}
                </p>
              </Card>
            </div>
          ) : null}

          {stepError ? (
            <p role="alert" className="text-sm text-red-700">
              {stepError}
            </p>
          ) : null}
          {currentStep === "review" && submitError ? <p className="text-sm text-red-700">{submitError}</p> : null}
        </div>
        <PoweredByFooter show={organizationQuery.data?.show_powered_by} />
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={goPrevious}
            disabled={stepIndex === 0}
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          {currentStep === "review" ? (
            <button
              type="button"
              onClick={handleFinalSubmit}
              disabled={submitting}
              className="rounded-lg px-6 py-2.5 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-60"
              style={{ backgroundColor: "var(--color-accent)" }}
            >
              {submitting ? "Submitting…" : "Submit application"}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              className="rounded-lg px-6 py-2.5 text-sm font-medium text-white transition"
              style={{ backgroundColor: "var(--color-accent)" }}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
