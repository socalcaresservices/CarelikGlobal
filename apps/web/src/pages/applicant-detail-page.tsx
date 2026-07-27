import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Card, StatusBadge, type StatusTone } from "@carelik/ui";
import { applicantStatusSchema, type ApplicantStatus } from "@carelik/shared";
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
  last_name: string;
  email: string;
  phone: string | null;
  status: ApplicantStatus;
  desired_weekly_hours: number | null;
  min_weekly_hours: number | null;
  max_weekly_hours: number | null;
  min_shift_hours: number | null;
  max_shift_hours: number | null;
  preferred_cities: string[];
  max_travel_minutes: number | null;
  transportation_method: string | null;
  willing_to_transport_clients: boolean | null;
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

interface MemberOption {
  user_id: string;
  display_name: string;
  status: string;
}

const statusTone: Record<ApplicantStatus, StatusTone> = {
  new: "info",
  reviewing: "warning",
  hired: "success",
  rejected: "neutral",
  withdrawn: "neutral"
};

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

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
            {applicant.first_name} {applicant.last_name}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {applicant.email}
            {applicant.phone ? ` · ${applicant.phone}` : ""}
          </p>
        </div>
        <StatusBadge label={applicant.status} tone={statusTone[applicant.status]} />
      </div>

      {canManage && applicant.status !== "hired" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Status</h3>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {manualStatusOptions.map((option) => (
              <button
                key={option}
                type="button"
                disabled={statusSaving || applicant.status === option}
                onClick={() => handleStatusChange(option)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark {option}
              </button>
            ))}
          </div>
          {statusError ? <p className="mt-2 text-sm text-red-700">{statusError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <h3 className="font-semibold text-slate-950">Hours and preferences</h3>
        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
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
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Preferred cities</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.preferred_cities.length > 0 ? applicant.preferred_cities.join(", ") : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Max travel time</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.max_travel_minutes != null ? `${applicant.max_travel_minutes} min` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Transportation</p>
            <p className="mt-0.5 font-semibold text-slate-950">
              {applicant.transportation_method ?? "—"}
              {applicant.willing_to_transport_clients ? " · willing to transport clients" : ""}
            </p>
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
        ) : (availabilityQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No availability submitted.</p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {WEEKDAYS.filter((day) => (availabilityQuery.data ?? []).some((row) => row.day_of_week === day)).map(
              (day) => {
                const row = availabilityQuery.data!.find((candidate) => candidate.day_of_week === day)!;
                return (
                  <div key={day} className="flex items-center gap-3 text-sm">
                    <span className="w-24 font-medium text-slate-800">{capitalize(day)}</span>
                    <span className="text-slate-600">
                      {row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)}
                    </span>
                    {row.preference === "preferred" ? (
                      <StatusBadge label="Preferred" tone="info" />
                    ) : null}
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
                <button
                  type="button"
                  disabled={!selectedMemberId || converting}
                  onClick={handleConvert}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {converting ? "Converting…" : "Convert to caregiver"}
                </button>
              </div>
              {convertError ? <p className="mt-2 text-sm text-red-700">{convertError}</p> : null}
            </>
          )}
        </Card>
      ) : null}
    </section>
  );
}
