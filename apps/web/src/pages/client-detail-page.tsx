import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Card, cn } from "@carelik/ui";
import { getUtilizationStatus, isAuthorizationActive } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

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
  payer: string;
  authorized_hours: number;
  period_start: string;
  period_end: string;
  scheduled_hours: number;
}

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
  const [tab, setTab] = useState<Tab>("overview");

  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canReadAudit = hasPermission("audit.read");

  const clientQuery = useQuery({
    queryKey: ["client-detail", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("clients").select("*").eq("id", id!).single();
      if (error) throw error;
      return data as ClientDetail;
    },
    enabled: !!id
  });

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
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Authorized</p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {formatHours(activeAuthorization.authorized_hours)}h
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Scheduled / Gap</p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {formatHours(activeAuthorization.scheduled_hours)}h
                    <span
                      className={cn(
                        "ml-2 text-sm font-medium",
                        getUtilizationStatus(activeAuthorization.authorized_hours, activeAuthorization.scheduled_hours) ===
                          "over"
                          ? "text-red-600"
                          : "text-slate-500"
                      )}
                    >
                      ({formatHours(activeAuthorization.authorized_hours - activeAuthorization.scheduled_hours)}h gap)
                    </span>
                  </p>
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
        </Card>
      ) : null}

      {tab === "schedule" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Shifts</h3>
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
          <h3 className="font-semibold text-slate-950">Authorizations</h3>
          {authorizationsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : (authorizationsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No authorizations on file.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(authorizationsQuery.data ?? []).map((row) => (
                <li key={row.id} className="py-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{row.payer}</span>
                    <span className="text-slate-500">
                      {new Date(row.period_start).toLocaleDateString()} –{" "}
                      {new Date(row.period_end).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatHours(row.scheduled_hours)}h scheduled of {formatHours(row.authorized_hours)}h authorized
                  </p>
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
