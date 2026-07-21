import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Card, FormSection, MultiSelectCombobox, StatusBadge, cn, type ComboboxOption, type StatusTone } from "@carelik/ui";
import {
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  isAuthorizationActive,
  type AuthorizationExpiryStatus,
  type AuthorizationUsageStatus
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

function parseTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

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
  client_requested_services: Array<{ service_id: string; services: { id: string; name: string } | null }>;
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
  over_limit: "danger"
};

const usageLabelText: Record<AuthorizationUsageStatus, string> = {
  normal: "Normal usage",
  approaching_limit: "Approaching limit",
  at_limit: "At limit",
  over_limit: "Over limit"
};

const expiryTone: Record<AuthorizationExpiryStatus, StatusTone> = {
  active: "success",
  expiring_soon: "warning",
  expired: "danger"
};

const expiryLabelText: Record<AuthorizationExpiryStatus, string> = {
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired"
};

interface IncidentRow {
  id: string;
  client_id: string | null;
  occurred_at: string;
  category: string;
  severity: "low" | "medium" | "high";
  status: "open" | "under_review" | "resolved";
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
  discharged: "bg-amber-50 text-amber-700"
};

type Tab = "overview" | "schedule" | "authorizations" | "incidents" | "notes" | "history";

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");

  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canManageAuthorizations = hasPermission("authorizations.update");
  const canReadAudit = hasPermission("audit.read");
  const canManage = hasPermission("clients.update");
  const canSchedule = hasPermission("shifts.update");

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
    enabled: !!id
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
    enabled: !!activeOrganizationId && canManage
  });

  const [profileForm, setProfileForm] = useState({
    city: "",
    state: "",
    zip: "",
    languageNeeds: "",
    careNeeds: "",
    requestedServiceIds: [] as string[]
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (clientQuery.data) {
      setProfileForm({
        city: clientQuery.data.address_city ?? "",
        state: clientQuery.data.address_state ?? "",
        zip: clientQuery.data.address_zip ?? "",
        languageNeeds: (clientQuery.data.language_needs ?? []).join(", "),
        careNeeds: (clientQuery.data.care_needs ?? []).join(", "),
        requestedServiceIds: (clientQuery.data.client_requested_services ?? []).map((row) => row.service_id)
      });
    }
  }, [clientQuery.data]);

  const requestedServiceOptions: ComboboxOption[] = (servicesQuery.data ?? [])
    .filter((service) => service.is_active)
    .map((service) => ({ value: service.id, label: service.name }));

  const requestedServiceLabels: Record<string, string> = Object.fromEntries(
    (clientQuery.data?.client_requested_services ?? [])
      .filter((row) => row.services)
      .map((row) => [row.service_id, row.services!.name])
  );

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !activeOrganizationId) return;

    setProfileError(null);
    setProfileSaving(true);
    try {
      const { error } = await supabase
        .from("clients")
        .update({
          address_city: profileForm.city || null,
          address_state: profileForm.state || null,
          address_zip: profileForm.zip || null,
          language_needs: parseTags(profileForm.languageNeeds),
          care_needs: parseTags(profileForm.careNeeds)
        })
        .eq("id", id);
      if (error) throw error;

      // Requested services are a separate join table (client_requested_services),
      // not an array column - replace-the-full-set is simplest and matches how
      // infrequently this changes (a handful of services per client, edited
      // rarely, not a high-write list).
      const { error: deleteError } = await supabase.from("client_requested_services").delete().eq("client_id", id);
      if (deleteError) throw deleteError;
      if (profileForm.requestedServiceIds.length > 0) {
        const { error: insertError } = await supabase.from("client_requested_services").insert(
          profileForm.requestedServiceIds.map((serviceId) => ({
            organization_id: activeOrganizationId,
            client_id: id,
            service_id: serviceId
          }))
        );
        if (insertError) throw insertError;
      }

      void queryClient.invalidateQueries({ queryKey: ["client-detail", id] });
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : "Could not save profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  const shiftsQuery = useQuery({
    queryKey: ["client-detail-shifts", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as ShiftRow[]).filter((row) => row.client_id === id);
    },
    enabled: !!activeOrganizationId && !!id
  });

  const authorizationsQuery = useQuery({
    queryKey: ["client-detail-authorizations", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_authorizations", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as AuthorizationRow[]).filter((row) => row.client_id === id);
    },
    enabled: !!activeOrganizationId && !!id && canSeeAuthorizations
  });

  const incidentsQuery = useQuery({
    queryKey: ["client-detail-incidents", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as IncidentRow[]).filter((row) => row.client_id === id);
    },
    enabled: !!activeOrganizationId && !!id
  });

  const auditQuery = useQuery({
    queryKey: ["client-detail-audit", activeOrganizationId, id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as AuditRow[]).filter(
        (row) => row.entity_type === "clients" && row.entity_id === id
      );
    },
    enabled: !!activeOrganizationId && !!id && canReadAudit
  });

  if (clientQuery.isLoading) {
    return <p className="mx-auto max-w-4xl text-sm text-slate-500">Loading…</p>;
  }

  if (clientQuery.isError || !clientQuery.data) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Client</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not found</h2>
          <p className="mt-3 text-slate-600">This client record doesn&apos;t exist or you can&apos;t view it.</p>
          <Link to="/clients" className="mt-4 inline-block text-sm font-medium text-slate-700 hover:underline">
            Back to clients
          </Link>
        </Card>
      </section>
    );
  }

  const client = clientQuery.data;
  const activeAuthorization = (authorizationsQuery.data ?? []).find((row) =>
    isAuthorizationActive(row.period_start, row.period_end)
  );
  const activeAuthorizationCommittedHours = activeAuthorization
    ? activeAuthorization.hours_used_this_month + activeAuthorization.hours_scheduled_this_month
    : 0;
  const activeAuthorizationUsage = activeAuthorization
    ? getAuthorizationUsageStatus(
        activeAuthorization.max_monthly_hours,
        activeAuthorization.hours_used_this_month,
        activeAuthorization.hours_scheduled_this_month
      )
    : null;
  const upcomingShiftCount = (shiftsQuery.data ?? []).filter(
    (row) => row.status === "scheduled" && new Date(row.starts_at).getTime() >= Date.now()
  ).length;
  const openIncidentCount = (incidentsQuery.data ?? []).filter((row) => row.status !== "resolved").length;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "schedule", label: "Schedule" },
    ...(canSeeAuthorizations ? [{ key: "authorizations" as Tab, label: "Authorizations" }] : []),
    { key: "incidents", label: "Incidents" },
    { key: "notes", label: "Notes" },
    ...(canReadAudit ? [{ key: "history" as Tab, label: "History" }] : [])
  ];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/clients" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" />
        Clients
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              {client.first_name} {client.last_name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {client.phone ?? "No phone"} · {client.email ?? "No email"}
            </p>
          </div>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", statusStyles[client.status])}>
            {client.status}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-6 sm:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Upcoming shifts</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{upcomingShiftCount}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Open incidents</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{openIncidentCount}</p>
          </div>
          {canSeeAuthorizations ? (
            activeAuthorization ? (
              <>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Cap this month</p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {formatHours(activeAuthorization.max_monthly_hours)}h
                  </p>
                  <p className="text-xs text-slate-500">{activeAuthorization.service_name}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Used + scheduled</p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">{formatHours(activeAuthorizationCommittedHours)}h</p>
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
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Authorization</p>
                <p className="mt-1 text-sm text-slate-500">No active authorization for today.</p>
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
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Phone</dt>
              <dd className="mt-1 text-sm text-slate-700">{client.phone ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Email</dt>
              <dd className="mt-1 text-sm text-slate-700">{client.email ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Address</dt>
              <dd className="mt-1 text-sm text-slate-700">{client.address ?? "—"}</dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-slate-100 pt-6">
            <h4 className="text-sm font-semibold text-slate-950">Location &amp; care needs</h4>
            <p className="mt-1 text-xs text-slate-500">
              Used for CareScore - the client/caregiver match score shown when scheduling.
            </p>
            {canManage ? (
              <form onSubmit={handleSaveProfile} className="mt-4 space-y-5">
                <FormSection title="Location" columns={2}>
                  <div>
                    <label htmlFor="client-city" className="block text-xs font-medium text-slate-600">
                      City
                    </label>
                    <input
                      id="client-city"
                      value={profileForm.city}
                      onChange={(event) => setProfileForm({ ...profileForm, city: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="client-state" className="block text-xs font-medium text-slate-600">
                        State
                      </label>
                      <input
                        id="client-state"
                        value={profileForm.state}
                        onChange={(event) => setProfileForm({ ...profileForm, state: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                    <div>
                      <label htmlFor="client-zip" className="block text-xs font-medium text-slate-600">
                        ZIP
                      </label>
                      <input
                        id="client-zip"
                        value={profileForm.zip}
                        onChange={(event) => setProfileForm({ ...profileForm, zip: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                  </div>
                </FormSection>

                <FormSection title="Needs" description="Used for CareScore matching." columns={2}>
                  <div>
                    <label htmlFor="client-language-needs" className="block text-xs font-medium text-slate-600">
                      Language needs (comma-separated)
                    </label>
                    <input
                      id="client-language-needs"
                      placeholder="Spanish"
                      value={profileForm.languageNeeds}
                      onChange={(event) => setProfileForm({ ...profileForm, languageNeeds: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div>
                    <label htmlFor="client-care-needs" className="block text-xs font-medium text-slate-600">
                      Care needs (comma-separated)
                    </label>
                    <input
                      id="client-care-needs"
                      placeholder="Hoyer lift, Dementia care"
                      value={profileForm.careNeeds}
                      onChange={(event) => setProfileForm({ ...profileForm, careNeeds: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                </FormSection>

                <FormSection
                  title="Services requested"
                  description="What this client has asked for - separate from a payer authorization's hours."
                  columns={1}
                >
                  <MultiSelectCombobox
                    label="Services"
                    values={profileForm.requestedServiceIds}
                    onChange={(values) => setProfileForm({ ...profileForm, requestedServiceIds: values })}
                    options={requestedServiceOptions}
                    selectedLabels={requestedServiceLabels}
                    placeholder="Search services…"
                  />
                </FormSection>

                <div>
                  <button
                    type="submit"
                    disabled={profileSaving}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {profileSaving ? "Saving…" : "Save"}
                  </button>
                </div>
                {profileError ? <p className="text-sm text-red-700">{profileError}</p> : null}
              </form>
            ) : (
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Location</dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {[client.address_city, client.address_state].filter(Boolean).join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Language needs</dt>
                  <dd className="mt-1 text-sm text-slate-700">{(client.language_needs ?? []).join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Care needs</dt>
                  <dd className="mt-1 text-sm text-slate-700">{(client.care_needs ?? []).join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Services requested</dt>
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
          ) : (shiftsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No shifts for this client.</p>
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
                    <span className="text-slate-500">{shift.caregiver_name}</span>
                    <span className="text-xs font-medium text-slate-500">{shift.status.replace("_", " ")}</span>
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
            {canManageAuthorizations ? (
              <Link
                to={`/authorizations?clientId=${id}`}
                className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                Add authorization for this client
              </Link>
            ) : null}
          </div>
          {authorizationsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : (authorizationsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No authorizations on file.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(authorizationsQuery.data ?? []).map((row) => {
                const usage = getAuthorizationUsageStatus(
                  row.max_monthly_hours,
                  row.hours_used_this_month,
                  row.hours_scheduled_this_month
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
                        {formatHours(row.hours_used_this_month)}h used + {formatHours(row.hours_scheduled_this_month)}h
                        scheduled of {formatHours(row.max_monthly_hours)}h/mo
                      </p>
                      <StatusBadge label={usageLabelText[usage]} tone={usageTone[usage]} />
                      <StatusBadge label={expiryLabelText[expiry]} tone={expiryTone[expiry]} />
                    </div>
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
          ) : (incidentsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No incidents reported for this client.</p>
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

      {tab === "notes" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Care notes</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">
            {client.care_notes ?? "No notes on file."}
          </p>
        </Card>
      ) : null}

      {tab === "history" && canReadAudit ? (
        <Card>
          <h3 className="font-semibold text-slate-950">History</h3>
          {auditQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : (auditQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No recorded changes yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(auditQuery.data ?? []).map((row) => (
                <li key={row.id} className="py-2.5 text-sm">
                  <span className="text-slate-700">{row.actor_display_name}</span>{" "}
                  <span className="text-slate-500">{row.action}</span>{" "}
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
