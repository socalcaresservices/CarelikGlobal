import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clipboard } from "lucide-react";
import {
  Button,
  Card,
  FormSection,
  MultiSelectCombobox,
  SearchableCombobox,
  StatusBadge,
  cn,
  type ComboboxOption,
  type StatusTone,
} from "@carelik/ui";
import {
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  isAuthorizationActive,
  type AuthorizationExpiryStatus,
  type AuthorizationUsageStatus,
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ClientRequestedSchedule } from "@/components/client-requested-schedule";

// Record layout per docs/design-system.md: header with every headline
// metric visible at once, a KPI row for the thing that matters most for
// this entity (authorized/scheduled/remaining/gap), then tabs for
// everything else. No number here is fabricated - the KPI row shows a
// clear "no active authorization" state rather than zeros when there
// isn't one, and every tab is backed by the same RPCs the list pages use
// (list_shifts/list_client_authorizations/list_incidents/list_audit_logs),
// filtered client-side to this client's id.

interface ClientDetail {
  id: string;
  client_code: string;
  caregiver_display_code: string | null;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  care_notes: string | null;
  status: "active" | "inactive" | "discharged";
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  language_needs: string[];
  care_needs: string[];
  client_requested_services: Array<{
    service_id: string;
    services: { id: string; name: string } | null;
  }>;
}

interface ServiceRow {
  id: string;
  name: string;
  is_active: boolean;
}

interface ShiftRow {
  id: string;
  client_id: string;
  caregiver_name: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

interface AuthorizationRow {
  id: string;
  client_id: string;
  service_name: string;
  payer: string;
  max_monthly_hours: number;
  period_start: string;
  period_end: string;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
}

const usageTone: Record<AuthorizationUsageStatus, StatusTone> = {
  normal: "success",
  approaching_limit: "warning",
  at_limit: "danger",
  over_limit: "danger",
};

const usageLabelText: Record<AuthorizationUsageStatus, string> = {
  normal: "Normal usage",
  approaching_limit: "Approaching limit",
  at_limit: "At limit",
  over_limit: "Over limit",
};

const expiryTone: Record<AuthorizationExpiryStatus, StatusTone> = {
  active: "success",
  expiring_soon: "warning",
  expired: "danger",
};

const expiryLabelText: Record<AuthorizationExpiryStatus, string> = {
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired",
};

interface IncidentRow {
  id: string;
  client_id: string | null;
  occurred_at: string;
  category: string;
  severity: "low" | "medium" | "high";
  status: "open" | "under_review" | "resolved";
}

interface AssignmentRow {
  id: string;
  caregiver_user_id: string;
  caregiver_name: string;
  client_id: string;
  service_id: string;
  service_name: string;
  service_code: string;
  effective_start: string;
  effective_end: string | null;
  is_active: boolean;
}

interface MemberOption {
  user_id: string;
  display_name: string;
  status: string;
}

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_display_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
}

const statusStyles: Record<ClientDetail["status"], string> = {
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-slate-100 text-slate-600",
  discharged: "bg-amber-50 text-amber-700",
};

type Tab =
  | "overview"
  | "schedule"
  | "matches"
  | "authorizations"
  | "caregivers"
  | "incidents"
  | "notes"
  | "history";

// CareScore's per-pair caregiver/client match score - see
// supabase/migrations/20260719280000_caregiver_client_matching.sql for
// the weighting model. Previously the only place a caregiver could see
// their real CareScore against a client was compressed into a single
// <option> label in the Schedule page's assignment dropdown ("Sam
// Caregiver — CareScore 87") - real numbers, but with no room to explain
// *why*. This tab gives the same real numbers (list_caregiver_matches(),
// no new RPC, no new calculation) a proper home with the full
// proximity/language/availability/skills/history breakdown, which is
// what makes it an *explainable* recommendation instead of a bare score.
interface CaregiverMatchDetailRow {
  caregiver_record_id: string;
  caregiver_name: string;
  match_score: number;
  proximity_score: number;
  language_score: number;
  availability_score: number;
  skills_score: number;
  history_score: number;
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [clientIdCopied, setClientIdCopied] = useState(false);

  async function copyClientId(clientCode: string) {
    try {
      await navigator.clipboard.writeText(clientCode);
      setClientIdCopied(true);
      window.setTimeout(() => setClientIdCopied(false), 1800);
    } catch {
      // Clipboard access can be denied by the browser - the code is still
      // shown on screen, so silently no-op rather than blocking the user.
    }
  }

  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canManageAuthorizations = hasPermission("authorizations.update");
  const canReadAudit = hasPermission("audit.read");
  const canManage = hasPermission("clients.update");
  const canSchedule = hasPermission("shifts.update");
  const canSeeAssignments = hasPermission("assignments.read");
  const canManageAssignments = hasPermission("assignments.update");

  const clientQuery = useQuery({
    queryKey: ["client-detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("*, client_requested_services(service_id, services(id, name))")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as ClientDetail;
    },
    enabled: !!id,
  });

  const servicesQuery = useQuery({
    queryKey: ["services", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("id, name, is_active")
        .eq("organization_id", activeOrganizationId!)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as ServiceRow[];
    },
    enabled: !!activeOrganizationId && canManage,
  });

  // Skills/languages pickers store the org's configured *names* directly
  // into care_needs/language_needs (text[]) - see
  // 20260727070000_skills_and_languages_catalog.sql for why this stays
  // name-based instead of switching to a foreign key.
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
      return (data ?? []) as ServiceRow[];
    },
    enabled: !!activeOrganizationId && canManage,
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
      return (data ?? []) as ServiceRow[];
    },
    enabled: !!activeOrganizationId && canManage,
  });

  const [profileForm, setProfileForm] = useState({
    caregiverDisplayCode: "",
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    careNotes: "",
    city: "",
    state: "",
    zip: "",
    languageNeeds: [] as string[],
    careNeeds: [] as string[],
    requestedServiceIds: [] as string[],
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);

  useEffect(() => {
    if (clientQuery.data) {
      setProfileForm({
        caregiverDisplayCode: clientQuery.data.caregiver_display_code ?? "",
        firstName: clientQuery.data.first_name ?? "",
        lastName: clientQuery.data.last_name ?? "",
        phone: clientQuery.data.phone ?? "",
        email: clientQuery.data.email ?? "",
        careNotes: clientQuery.data.care_notes ?? "",
        city: clientQuery.data.address_city ?? "",
        state: clientQuery.data.address_state ?? "",
        zip: clientQuery.data.address_zip ?? "",
        languageNeeds: clientQuery.data.language_needs ?? [],
        careNeeds: clientQuery.data.care_needs ?? [],
        requestedServiceIds: (
          clientQuery.data.client_requested_services ?? []
        ).map((row) => row.service_id),
      });
    }
  }, [clientQuery.data]);

  useEffect(() => {
    if (!profileSuccess) return;
    const timeout = setTimeout(() => setProfileSuccess(false), 5000);
    return () => clearTimeout(timeout);
  }, [profileSuccess]);

  const caregiverDisplayCodeIsValid =
    profileForm.caregiverDisplayCode.trim().length === 0 ||
    (profileForm.caregiverDisplayCode.trim().length >= 3 &&
      profileForm.caregiverDisplayCode.trim().length <= 40);
  const profileCanSave =
    profileForm.firstName.trim().length > 0 &&
    profileForm.lastName.trim().length > 0 &&
    caregiverDisplayCodeIsValid;

  const requestedServiceOptions: ComboboxOption[] = (servicesQuery.data ?? [])
    .filter((service) => service.is_active)
    .map((service) => ({ value: service.id, label: service.name }));

  const requestedServiceLabels: Record<string, string> = Object.fromEntries(
    (clientQuery.data?.client_requested_services ?? [])
      .filter((row) => row.services)
      .map((row) => [row.service_id, row.services!.name]),
  );

  const careNeedOptions: ComboboxOption[] = (skillsQuery.data ?? [])
    .filter((skill) => skill.is_active)
    .map((skill) => ({ value: skill.name, label: skill.name }));

  const languageNeedOptions: ComboboxOption[] = (languagesQuery.data ?? [])
    .filter((language) => language.is_active)
    .map((language) => ({ value: language.name, label: language.name }));

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !activeOrganizationId) return;
    if (!profileCanSave) {
      setProfileError(
        caregiverDisplayCodeIsValid
          ? "First name and last name are required."
          : "The caregiver-facing client code must be 3 to 40 characters.",
      );
      return;
    }

    setProfileError(null);
    setProfileSuccess(false);
    setProfileSaving(true);
    try {
      const { error } = await supabase
        .from("clients")
        .update({
          caregiver_display_code:
            profileForm.caregiverDisplayCode.trim() || null,
          first_name: profileForm.firstName.trim(),
          last_name: profileForm.lastName.trim(),
          phone: profileForm.phone.trim() || null,
          email: profileForm.email.trim() || null,
          care_notes: profileForm.careNotes.trim() || null,
          address_city: profileForm.city || null,
          address_state: profileForm.state || null,
          address_zip: profileForm.zip || null,
          language_needs: profileForm.languageNeeds,
          care_needs: profileForm.careNeeds,
        })
        .eq("organization_id", activeOrganizationId)
        .eq("id", id);
      if (error) throw error;

      // Requested services are a separate join table (client_requested_services),
      // not an array column - replace-the-full-set is simplest and matches how
      // infrequently this changes (a handful of services per client, edited
      // rarely, not a high-write list).
      const { error: deleteError } = await supabase
        .from("client_requested_services")
        .delete()
        .eq("client_id", id);
      if (deleteError) throw deleteError;
      if (profileForm.requestedServiceIds.length > 0) {
        const { error: insertError } = await supabase
          .from("client_requested_services")
          .insert(
            profileForm.requestedServiceIds.map((serviceId) => ({
              organization_id: activeOrganizationId,
              client_id: id,
              service_id: serviceId,
            })),
          );
        if (insertError) throw insertError;
      }

      void queryClient.invalidateQueries({ queryKey: ["client-detail", id] });
      void queryClient.invalidateQueries({
        queryKey: ["clients", activeOrganizationId],
      });
      setProfileSuccess(true);
    } catch (cause) {
      setProfileError(
        cause instanceof Error ? cause.message : "Could not save profile.",
      );
    } finally {
      setProfileSaving(false);
    }
  }

  const shiftsQuery = useQuery({
    queryKey: ["client-detail-shifts", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as ShiftRow[]).filter((row) => row.client_id === id);
    },
    enabled: !!activeOrganizationId && !!id,
  });

  const matchesQuery = useQuery({
    queryKey: ["client-detail-matches", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_matches", {
        target_organization_id: activeOrganizationId!,
        target_client_id: id!,
      });
      if (error) throw error;
      // Already sorted best-match-first by the RPC itself.
      return (data ?? []) as CaregiverMatchDetailRow[];
    },
    enabled: !!activeOrganizationId && !!id && canSchedule,
  });

  const authorizationsQuery = useQuery({
    queryKey: ["client-detail-authorizations", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_authorizations", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as AuthorizationRow[]).filter(
        (row) => row.client_id === id,
      );
    },
    enabled: !!activeOrganizationId && !!id && canSeeAuthorizations,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["client-detail-assignments", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_assignments", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as AssignmentRow[]).filter(
        (row) => row.client_id === id,
      );
    },
    enabled: !!activeOrganizationId && !!id && canSeeAssignments,
  });

  const assignableServicesQuery = useQuery({
    queryKey: ["services-for-assignments", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("id, code, name, is_active")
        .eq("organization_id", activeOrganizationId!)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (
        (data ?? []) as Array<{
          id: string;
          code: string;
          name: string;
          is_active: boolean;
        }>
      ).filter((service) => service.is_active);
    },
    enabled: !!activeOrganizationId && canManageAssignments,
  });

  const membersQuery = useQuery({
    queryKey: ["members-for-assignments", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as MemberOption[]).filter(
        (member) => member.status === "active",
      );
    },
    enabled: !!activeOrganizationId && canManageAssignments,
  });

  const [assignmentForm, setAssignmentForm] = useState({
    caregiverId: "",
    serviceId: "",
  });
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentPendingId, setAssignmentPendingId] = useState<string | null>(
    null,
  );

  async function handleAddAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId || !id) return;
    if (!assignmentForm.caregiverId || !assignmentForm.serviceId) {
      setAssignmentError("Select both a caregiver and a service.");
      return;
    }

    setAssignmentError(null);
    setAssignmentSaving(true);
    try {
      const { error } = await supabase.from("caregiver_assignments").insert({
        organization_id: activeOrganizationId,
        client_id: id,
        caregiver_user_id: assignmentForm.caregiverId,
        service_id: assignmentForm.serviceId,
      });
      if (error) throw error;
      setAssignmentForm({ caregiverId: "", serviceId: "" });
      void queryClient.invalidateQueries({
        queryKey: ["client-detail-assignments", activeOrganizationId, id],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setAssignmentError(
        message.includes("caregiver_assignments_unique_active")
          ? "This caregiver is already assigned to this client for this service."
          : message || "Could not add the assignment.",
      );
    } finally {
      setAssignmentSaving(false);
    }
  }

  async function handleToggleAssignment(row: AssignmentRow) {
    setAssignmentError(null);
    setAssignmentPendingId(row.id);
    try {
      const { error } = await supabase
        .from("caregiver_assignments")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
      void queryClient.invalidateQueries({
        queryKey: ["client-detail-assignments", activeOrganizationId, id],
      });
    } catch (cause) {
      setAssignmentError(
        cause instanceof Error
          ? cause.message
          : "Could not update the assignment.",
      );
    } finally {
      setAssignmentPendingId(null);
    }
  }

  const incidentsQuery = useQuery({
    queryKey: ["client-detail-incidents", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as IncidentRow[]).filter(
        (row) => row.client_id === id,
      );
    },
    enabled: !!activeOrganizationId && !!id,
  });

  const auditQuery = useQuery({
    queryKey: ["client-detail-audit", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return ((data ?? []) as AuditRow[]).filter(
        (row) => row.entity_type === "clients" && row.entity_id === id,
      );
    },
    enabled: !!activeOrganizationId && !!id && canReadAudit,
  });

  if (clientQuery.isLoading) {
    return <p className="mx-auto max-w-4xl text-sm text-slate-500">Loading…</p>;
  }

  if (clientQuery.isError || !clientQuery.data) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Client</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            Not found
          </h2>
          <p className="mt-3 text-slate-600">
            This client record doesn&apos;t exist or you can&apos;t view it.
          </p>
          <Link
            to="/clients"
            className="mt-4 inline-block text-sm font-medium text-slate-700 hover:underline"
          >
            Back to clients
          </Link>
        </Card>
      </section>
    );
  }

  const client = clientQuery.data;
  const activeAuthorization = (authorizationsQuery.data ?? []).find((row) =>
    isAuthorizationActive(row.period_start, row.period_end),
  );
  const activeAuthorizationCommittedHours = activeAuthorization
    ? activeAuthorization.hours_used_this_month +
      activeAuthorization.hours_scheduled_this_month
    : 0;
  // Gap/Remaining: the cap minus what's already used or on the schedule
  // this month - clamped at 0 so an over-limit authorization (the
  // over-authorized Action Center signal's concern, not this one's)
  // reads as "0h remaining", not a negative number.
  const activeAuthorizationRemainingHours = activeAuthorization
    ? Math.max(
        0,
        activeAuthorization.max_monthly_hours -
          activeAuthorizationCommittedHours,
      )
    : 0;
  const activeAuthorizationUsage = activeAuthorization
    ? getAuthorizationUsageStatus(
        activeAuthorization.max_monthly_hours,
        activeAuthorization.hours_used_this_month,
        activeAuthorization.hours_scheduled_this_month,
      )
    : null;
  const upcomingShiftCount = (shiftsQuery.data ?? []).filter(
    (row) =>
      row.status === "scheduled" &&
      new Date(row.starts_at).getTime() >= Date.now(),
  ).length;
  const openIncidentCount = (incidentsQuery.data ?? []).filter(
    (row) => row.status !== "resolved",
  ).length;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "schedule", label: "Schedule" },
    ...(canSchedule ? [{ key: "matches" as Tab, label: "Matches" }] : []),
    ...(canSeeAuthorizations
      ? [{ key: "authorizations" as Tab, label: "Authorizations" }]
      : []),
    ...(canSeeAssignments
      ? [{ key: "caregivers" as Tab, label: "Caregivers" }]
      : []),
    { key: "incidents", label: "Incidents" },
    { key: "notes", label: "Notes" },
    ...(canReadAudit ? [{ key: "history" as Tab, label: "History" }] : []),
  ];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link
        to="/clients"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Clients
      </Link>

      {/* Sticky for the same reason as caregiver-detail-page.tsx's header
          Card: identity, the authorization KPI row, and the tab bar stay
          visible while scrolling a long tab instead of scrolling away with
          it. See that page's comment for the top-0/z-20 reasoning. */}
      <Card className="sticky top-0 z-20">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              {client.first_name} {client.last_name}
            </h2>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="font-mono text-sm font-medium text-slate-700">
                {client.client_code}
              </span>
              <button
                type="button"
                onClick={() => void copyClientId(client.client_code)}
                aria-label="Copy Client ID"
                className="text-slate-400 hover:text-slate-700"
              >
                <Clipboard className="h-3.5 w-3.5" />
              </button>
              {clientIdCopied ? (
                <span className="text-xs text-emerald-700">Copied</span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {client.phone ?? "No phone"} · {client.email ?? "No email"}
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              statusStyles[client.status],
            )}
          >
            {client.status}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-6 sm:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Upcoming shifts
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-950">
              {upcomingShiftCount}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Open incidents
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-950">
              {openIncidentCount}
            </p>
          </div>
          {canSeeAuthorizations ? (
            activeAuthorization ? (
              <>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Cap this month
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {formatHours(activeAuthorization.max_monthly_hours)}h
                  </p>
                  <p className="text-xs text-slate-500">
                    {activeAuthorization.service_name}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Used + scheduled
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {formatHours(activeAuthorizationCommittedHours)}h
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatHours(activeAuthorizationRemainingHours)}h remaining
                  </p>
                  {activeAuthorizationUsage ? (
                    <StatusBadge
                      className="mt-1"
                      label={usageLabelText[activeAuthorizationUsage]}
                      tone={usageTone[activeAuthorizationUsage]}
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <div className="col-span-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Authorization
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  No active authorization for today.
                </p>
              </div>
            )
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-1 border-t border-slate-100 pt-4">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium",
                tab === key
                  ? "bg-[var(--color-accent,#0f172a)] text-[var(--color-accent-foreground,#ffffff)]"
                  : "text-slate-600 hover:bg-slate-100",
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
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Phone
              </dt>
              <dd className="mt-1 text-sm text-slate-700">
                {client.phone ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Email
              </dt>
              <dd className="mt-1 text-sm text-slate-700">
                {client.email ?? "—"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Address
              </dt>
              <dd className="mt-1 text-sm text-slate-700">
                {client.address ?? "—"}
              </dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-slate-100 pt-6">
            <h4 className="text-sm font-semibold text-slate-950">
              Location &amp; care needs
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Used for CareScore - the client/caregiver match score shown when
              scheduling.
            </p>
            {canManage ? (
              <form onSubmit={handleSaveProfile} className="mt-4 space-y-5">
                <FormSection title="Caregiver sign-in label" columns={1}>
                  <div>
                    <label
                      htmlFor="caregiver-display-code"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Caregiver-facing client code
                    </label>
                    <input
                      id="caregiver-display-code"
                      value={profileForm.caregiverDisplayCode}
                      maxLength={40}
                      placeholder="Example: Bluebird or Maple-2"
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          caregiverDisplayCode: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Shown only to assigned caregivers on the sign-in sheet.
                      Use a short, familiar label—not a full name, UCI, date of
                      birth, phone number, or full address.
                    </p>
                  </div>
                </FormSection>
                <FormSection title="Contact" columns={2}>
                  <div>
                    <label
                      htmlFor="client-first-name"
                      className="block text-xs font-medium text-slate-600"
                    >
                      First name
                    </label>
                    <input
                      id="client-first-name"
                      value={profileForm.firstName}
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          firstName: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="client-last-name"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Last name
                    </label>
                    <input
                      id="client-last-name"
                      value={profileForm.lastName}
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          lastName: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="client-phone"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Phone
                    </label>
                    <input
                      id="client-phone"
                      value={profileForm.phone}
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          phone: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="client-email"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Email
                    </label>
                    <input
                      id="client-email"
                      type="email"
                      value={profileForm.email}
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          email: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                </FormSection>

                <FormSection title="Location" columns={2}>
                  <div>
                    <label
                      htmlFor="client-city"
                      className="block text-xs font-medium text-slate-600"
                    >
                      City
                    </label>
                    <input
                      id="client-city"
                      value={profileForm.city}
                      onChange={(event) =>
                        setProfileForm({
                          ...profileForm,
                          city: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="client-state"
                        className="block text-xs font-medium text-slate-600"
                      >
                        State
                      </label>
                      <input
                        id="client-state"
                        value={profileForm.state}
                        onChange={(event) =>
                          setProfileForm({
                            ...profileForm,
                            state: event.target.value,
                          })
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="client-zip"
                        className="block text-xs font-medium text-slate-600"
                      >
                        ZIP
                      </label>
                      <input
                        id="client-zip"
                        value={profileForm.zip}
                        onChange={(event) =>
                          setProfileForm({
                            ...profileForm,
                            zip: event.target.value,
                          })
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                  </div>
                </FormSection>

                <FormSection
                  title="Requested days and times"
                  description="Add up to two requested shifts per day, including optional free-text timing notes."
                  columns={1}
                >
                  <ClientRequestedSchedule
                    organizationId={activeOrganizationId!}
                    clientId={id!}
                    canManage={canManage}
                  />
                </FormSection>

                <FormSection
                  title="Needs"
                  description="Used for CareScore matching."
                  columns={2}
                >
                  <MultiSelectCombobox
                    label="Language needs"
                    values={profileForm.languageNeeds}
                    onChange={(values) =>
                      setProfileForm({ ...profileForm, languageNeeds: values })
                    }
                    options={languageNeedOptions}
                    placeholder="Search languages…"
                  />
                  <MultiSelectCombobox
                    label="Care needs"
                    values={profileForm.careNeeds}
                    onChange={(values) =>
                      setProfileForm({ ...profileForm, careNeeds: values })
                    }
                    options={careNeedOptions}
                    placeholder="Search skills…"
                  />
                </FormSection>

                <FormSection
                  title="Services requested"
                  description="What this client has asked for - separate from a payer authorization's hours."
                  columns={1}
                >
                  <MultiSelectCombobox
                    label="Services"
                    values={profileForm.requestedServiceIds}
                    onChange={(values) =>
                      setProfileForm({
                        ...profileForm,
                        requestedServiceIds: values,
                      })
                    }
                    options={requestedServiceOptions}
                    selectedLabels={requestedServiceLabels}
                    placeholder="Search services…"
                  />
                </FormSection>

                <div>
                  <Button
                    type="submit"
                    loading={profileSaving}
                    disabled={!profileCanSave || profileSaving}
                  >
                    {profileSaving ? "Saving…" : "Save"}
                  </Button>
                </div>
                {profileError ? (
                  <p className="text-sm text-red-700">{profileError}</p>
                ) : null}
                {profileSuccess ? (
                  <p className="text-sm text-emerald-700">
                    Client profile updated.
                  </p>
                ) : null}
              </form>
            ) : (
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Location
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {[client.address_city, client.address_state]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Language needs
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {(client.language_needs ?? []).join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Care needs
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {(client.care_needs ?? []).join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Services requested
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {(client.client_requested_services ?? [])
                      .map((row) => row.services?.name)
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </Card>
      ) : null}

      {tab === "schedule" ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-950">Shifts</h3>
            {canSchedule ? (
              <Link
                to={`/schedule?clientId=${id}`}
                className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                Assign a caregiver (ranked by CareScore)
              </Link>
            ) : null}
          </div>
          {shiftsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : shiftsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load shifts for this client.
            </p>
          ) : (shiftsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No shifts for this client.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(shiftsQuery.data ?? [])
                .slice()
                .sort(
                  (a, b) =>
                    new Date(b.starts_at).getTime() -
                    new Date(a.starts_at).getTime(),
                )
                .map((shift) => (
                  <li
                    key={shift.id}
                    className="flex items-center justify-between py-2.5 text-sm"
                  >
                    <span className="text-slate-700">
                      {new Date(shift.starts_at).toLocaleString()} –{" "}
                      {new Date(shift.ends_at).toLocaleTimeString()}
                    </span>
                    <span className="text-slate-500">
                      {shift.caregiver_name}
                    </span>
                    <span className="text-xs font-medium text-slate-500">
                      {shift.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "matches" && canSchedule ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Caregiver matches</h3>
          <p className="mt-1 text-xs text-slate-500">
            CareScore ranks active caregivers against this client on proximity,
            language, availability, skills, and shared history - the same score
            shown when assigning a shift, with the breakdown that explains it.
          </p>
          {matchesQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : matchesQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load caregiver matches.
            </p>
          ) : (matchesQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No active caregivers to match against.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(matchesQuery.data ?? []).map((match) => (
                <li key={match.caregiver_record_id} className="py-3">
                  <div className="flex items-center justify-between">
                    <Link
                      to="/team"
                      className="text-sm font-medium text-slate-900 hover:underline"
                    >
                      {match.caregiver_name}
                    </Link>
                    <span className="text-lg font-semibold tabular-nums text-slate-950">
                      {match.match_score}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>Proximity {match.proximity_score}/30</span>
                    <span>Language {match.language_score}/25</span>
                    <span>Availability {match.availability_score}/20</span>
                    <span>Skills {match.skills_score}/10</span>
                    <span>History {match.history_score}/15</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "authorizations" && canSeeAuthorizations ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-950">Authorizations</h3>
          </div>
          {canManageAuthorizations ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {(client.client_requested_services ?? []).map((row) =>
                row.services ? (
                  <Link
                    key={row.service_id}
                    to={`/authorizations?clientId=${id}&serviceId=${row.service_id}`}
                    className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Add {row.services.name} authorization
                  </Link>
                ) : null,
              )}
              {(client.client_requested_services ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  Select requested services on Overview before adding
                  authorizations.
                </p>
              ) : null}
            </div>
          ) : null}
          {authorizationsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : authorizationsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load authorizations for this client.
            </p>
          ) : (authorizationsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No authorizations on file.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(authorizationsQuery.data ?? []).map((row) => {
                const usage = getAuthorizationUsageStatus(
                  row.max_monthly_hours,
                  row.hours_used_this_month,
                  row.hours_scheduled_this_month,
                );
                const expiry = getAuthorizationExpiryStatus(row.period_end);
                return (
                  <li key={row.id} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-700">
                        {row.service_name} · {row.payer}
                      </span>
                      <span className="text-slate-500">
                        {new Date(row.period_start).toLocaleDateString()} –{" "}
                        {new Date(row.period_end).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="text-xs text-slate-500">
                        {formatHours(row.hours_used_this_month)}h used +{" "}
                        {formatHours(row.hours_scheduled_this_month)}h scheduled
                        of {formatHours(row.max_monthly_hours)}h/mo (
                        {formatHours(
                          Math.max(
                            0,
                            row.max_monthly_hours -
                              row.hours_used_this_month -
                              row.hours_scheduled_this_month,
                          ),
                        )}
                        h remaining)
                      </p>
                      <StatusBadge
                        label={usageLabelText[usage]}
                        tone={usageTone[usage]}
                      />
                      <StatusBadge
                        label={expiryLabelText[expiry]}
                        tone={expiryTone[expiry]}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "caregivers" && canSeeAssignments ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            Caregiver assignments
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Only caregivers assigned here can see or schedule visits for this
            client on their own staff portal - this is the gate, not just a
            suggestion like CareScore.
          </p>

          {canManageAssignments ? (
            <form
              onSubmit={handleAddAssignment}
              className="mt-4 flex flex-wrap items-end gap-3"
            >
              <div className="min-w-[12rem] flex-1">
                <SearchableCombobox
                  label="Caregiver"
                  value={assignmentForm.caregiverId || null}
                  onChange={(value) =>
                    setAssignmentForm({
                      ...assignmentForm,
                      caregiverId: value ?? "",
                    })
                  }
                  options={(membersQuery.data ?? []).map((member) => ({
                    value: member.user_id,
                    label: member.display_name,
                  }))}
                  placeholder="Search caregivers…"
                />
              </div>
              <div className="min-w-[12rem] flex-1">
                <SearchableCombobox
                  label="Service"
                  value={assignmentForm.serviceId || null}
                  onChange={(value) =>
                    setAssignmentForm({
                      ...assignmentForm,
                      serviceId: value ?? "",
                    })
                  }
                  options={(assignableServicesQuery.data ?? []).map(
                    (service) => ({
                      value: service.id,
                      label: `${service.code} · ${service.name}`,
                    }),
                  )}
                  placeholder="Search services…"
                />
              </div>
              <Button type="submit" loading={assignmentSaving}>
                {assignmentSaving ? "Assigning…" : "Assign"}
              </Button>
            </form>
          ) : null}
          {assignmentError ? (
            <p className="mt-2 text-sm text-red-700">{assignmentError}</p>
          ) : null}

          {assignmentsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : assignmentsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load caregiver assignments.
            </p>
          ) : (assignmentsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No caregivers assigned to this client yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(assignmentsQuery.data ?? []).map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <div>
                    <Link
                      to="/team"
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {row.caregiver_name}
                    </Link>
                    <span className="ml-2 text-slate-500">
                      {row.service_code} · {row.service_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge
                      label={row.is_active ? "Active" : "Revoked"}
                      tone={row.is_active ? "success" : "neutral"}
                    />
                    {canManageAssignments ? (
                      <button
                        type="button"
                        disabled={assignmentPendingId === row.id}
                        onClick={() => handleToggleAssignment(row)}
                        className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {row.is_active ? "Revoke" : "Reactivate"}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
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
            <p className="mt-3 text-sm text-red-700">
              Could not load incidents reported for this client.
            </p>
          ) : (incidentsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No incidents reported for this client.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(incidentsQuery.data ?? []).map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <span className="text-slate-700">{row.category}</span>
                  <span className="text-slate-500">
                    {new Date(row.occurred_at).toLocaleDateString()}
                  </span>
                  <span className="text-xs font-medium text-slate-500">
                    {row.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "notes" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Care notes</h3>
          {canManage ? (
            <form onSubmit={handleSaveProfile} className="mt-3 space-y-3">
              <textarea
                aria-label="Care notes"
                rows={6}
                value={profileForm.careNotes}
                onChange={(event) =>
                  setProfileForm({
                    ...profileForm,
                    careNotes: event.target.value,
                  })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
              <div>
                <Button
                  type="submit"
                  loading={profileSaving}
                  disabled={!profileCanSave || profileSaving}
                >
                  {profileSaving ? "Saving…" : "Save"}
                </Button>
              </div>
              {profileError ? (
                <p className="text-sm text-red-700">{profileError}</p>
              ) : null}
              {profileSuccess ? (
                <p className="text-sm text-emerald-700">
                  Client profile updated.
                </p>
              ) : null}
            </form>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">
              {client.care_notes ?? "No notes on file."}
            </p>
          )}
        </Card>
      ) : null}

      {tab === "history" && canReadAudit ? (
        <Card>
          <h3 className="font-semibold text-slate-950">History</h3>
          {auditQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : auditQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load history for this client.
            </p>
          ) : (auditQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No recorded changes yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(auditQuery.data ?? []).map((row) => (
                <li key={row.id} className="py-2.5 text-sm">
                  <span className="text-slate-700">
                    {row.actor_display_name}
                  </span>{" "}
                  <span className="text-slate-500">{row.action}</span>{" "}
                  <span className="text-xs text-slate-400">
                    {new Date(row.occurred_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </section>
  );
}
