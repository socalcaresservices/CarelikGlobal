import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { incidentSeveritySchema, incidentStatusSchema } from "@carelik/shared";
import type { IncidentSeverity, IncidentStatus } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Backed by list_incidents(), a security-definer RPC (see
// supabase/migrations/20260719270000_incidents.sql) that joins client/
// caregiver/reporter names. Access mirrors the table RLS: org-wide with
// incidents.read, or just the incidents you reported yourself.
interface IncidentRow {
  id: string;
  client_id: string | null;
  client_name: string | null;
  caregiver_user_id: string | null;
  caregiver_name: string | null;
  occurred_at: string;
  category: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  description: string;
  reported_by: string | null;
  reported_by_name: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
}

interface MemberOption {
  user_id: string;
  display_name: string;
}

const severityStyles: Record<IncidentSeverity, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-amber-50 text-amber-700",
  high: "bg-red-50 text-red-700"
};

const statusStyles: Record<IncidentStatus, string> = {
  open: "bg-red-50 text-red-700",
  under_review: "bg-amber-50 text-amber-700",
  resolved: "bg-emerald-50 text-emerald-700"
};

function toLocalInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

const emptyForm = {
  category: "",
  occurredAt: toLocalInputValue(new Date()),
  clientId: "",
  caregiverUserId: "",
  severity: "medium" as IncidentSeverity,
  description: ""
};

export function IncidentsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("incidents.read");
  const canCreate = hasPermission("incidents.create");
  const canManage = hasPermission("incidents.update");

  const incidentsQuery = useQuery({
    queryKey: ["incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as IncidentRow[];
    },
    enabled: !!activeOrganizationId
  });

  const clientsQuery = useQuery({
    queryKey: ["clients-for-incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, first_name, last_name")
        .eq("organization_id", activeOrganizationId!)
        .order("last_name");
      if (error) throw error;
      return (data ?? []) as ClientOption[];
    },
    enabled: !!activeOrganizationId && (canCreate || canManage)
  });

  const membersQuery = useQuery({
    queryKey: ["members-for-incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ user_id: string; display_name: string; status: string }>)
        .filter((member) => member.status === "active")
        .map((member): MemberOption => ({ user_id: member.user_id, display_name: member.display_name }));
    },
    enabled: !!activeOrganizationId && canManage
  });

  function refreshIncidents() {
    void queryClient.invalidateQueries({ queryKey: ["incidents", activeOrganizationId] });
  }

  const table = useTableControls<IncidentRow, "when" | "category" | "severity" | "status">(incidentsQuery.data, {
    matchesSearch: (row, query) =>
      row.category.toLowerCase().includes(query) ||
      (row.client_name ?? "").toLowerCase().includes(query) ||
      (row.caregiver_name ?? "").toLowerCase().includes(query),
    sorters: {
      when: (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
      category: (a, b) => a.category.localeCompare(b.category),
      severity: (a, b) => a.severity.localeCompare(b.severity),
      status: (a, b) => a.status.localeCompare(b.status)
    },
    defaultSort: "when"
  });

  const columns = useColumnWidths("carelik:column-widths:incidents", {
    when: 190,
    category: 160,
    client: 150,
    severity: 130,
    status: 150
  });

  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handleFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setFormError(null);
    setSaving(true);
    try {
      const {
        data: { user }
      } = await supabase.auth.getUser();

      const { error } = await supabase.from("incidents").insert({
        organization_id: activeOrganizationId,
        category: form.category,
        occurred_at: new Date(form.occurredAt).toISOString(),
        client_id: form.clientId || null,
        caregiver_user_id: form.caregiverUserId || null,
        severity: form.severity,
        description: form.description,
        reported_by: user?.id ?? null
      });
      if (error) throw error;
      setForm(emptyForm);
      refreshIncidents();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not file incident.");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(incidentId: string, nextStatus: IncidentStatus) {
    setRowError(null);
    setPendingId(incidentId);
    try {
      const payload: Record<string, unknown> = { status: nextStatus };
      if (nextStatus === "resolved") payload.resolved_at = new Date().toISOString();
      const { error } = await supabase.from("incidents").update(payload).eq("id", incidentId);
      if (error) throw error;
      refreshIncidents();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not update incident.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Incidents</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Incident reports"}
        </h2>
        {!canRead ? (
          <p className="mt-1 text-sm text-slate-500">Showing only incidents you reported.</p>
        ) : null}
      </div>

      {canCreate || canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">File an incident</h3>
          <form onSubmit={handleFile} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="incident-category" className="block text-xs font-medium text-slate-600">
                Category
              </label>
              <input
                id="incident-category"
                required
                placeholder="e.g. Fall"
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="incident-occurred" className="block text-xs font-medium text-slate-600">
                When it happened
              </label>
              <input
                id="incident-occurred"
                type="datetime-local"
                required
                value={form.occurredAt}
                onChange={(event) => setForm({ ...form, occurredAt: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="incident-client" className="block text-xs font-medium text-slate-600">
                Client (optional)
              </label>
              <select
                id="incident-client"
                value={form.clientId}
                onChange={(event) => setForm({ ...form, clientId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">None</option>
                {(clientsQuery.data ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.first_name} {client.last_name}
                  </option>
                ))}
              </select>
            </div>
            {membersQuery.data ? (
              <div>
                <label htmlFor="incident-caregiver" className="block text-xs font-medium text-slate-600">
                  Caregiver involved (optional)
                </label>
                <select
                  id="incident-caregiver"
                  value={form.caregiverUserId}
                  onChange={(event) => setForm({ ...form, caregiverUserId: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                >
                  <option value="">None</option>
                  {membersQuery.data.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.display_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label htmlFor="incident-severity" className="block text-xs font-medium text-slate-600">
                Severity
              </label>
              <select
                id="incident-severity"
                value={form.severity}
                onChange={(event) => setForm({ ...form, severity: event.target.value as IncidentSeverity })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                {incidentSeveritySchema.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="incident-description" className="block text-xs font-medium text-slate-600">
                What happened
              </label>
              <textarea
                id="incident-description"
                required
                rows={3}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Filing…" : "File incident"}
              </button>
            </div>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All incidents</h3>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search category, client, or caregiver"
            aria-label="Search incidents"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {incidentsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : incidentsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load incidents.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="When"
                  active={table.sortKey === "when"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("when")}
                  width={columns.widths.when}
                  onResizeStart={columns.startResize("when")}
                />
                <SortableHeader
                  label="Category"
                  active={table.sortKey === "category"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("category")}
                  width={columns.widths.category}
                  onResizeStart={columns.startResize("category")}
                />
                <PlainHeader
                  label="Client"
                  width={columns.widths.client}
                  onResizeStart={columns.startResize("client")}
                />
                <SortableHeader
                  label="Severity"
                  active={table.sortKey === "severity"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("severity")}
                  width={columns.widths.severity}
                  onResizeStart={columns.startResize("severity")}
                />
                <SortableHeader
                  label="Status"
                  active={table.sortKey === "status"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("status")}
                  width={columns.widths.status}
                  onResizeStart={columns.startResize("status")}
                />
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                const isPending = pendingId === row.id;
                return (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 whitespace-nowrap text-slate-600">
                      {new Date(row.occurred_at).toLocaleString()}
                    </td>
                    <td className="py-2.5 text-slate-800">{row.category}</td>
                    <td className="py-2.5 text-slate-600">{row.client_name ?? "—"}</td>
                    <td className="py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${severityStyles[row.severity]}`}>
                        {row.severity}
                      </span>
                    </td>
                    <td className="py-2.5">
                      {canManage ? (
                        <select
                          value={row.status}
                          disabled={isPending}
                          onChange={(event) => handleStatusChange(row.id, event.target.value as IncidentStatus)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        >
                          {incidentStatusSchema.options.map((option) => (
                            <option key={option} value={option}>
                              {option.replace("_", " ")}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[row.status]}`}>
                          {row.status.replace("_", " ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-400">
                    {table.search ? "No incidents match your search." : "No incidents reported."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </section>
  );
}
