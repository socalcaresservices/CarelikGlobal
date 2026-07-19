import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { getUtilizationStatus, isAuthorizationActive, type UtilizationStatus } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Backed by list_client_authorizations(), a security-definer RPC (see
// supabase/migrations/20260719260000_client_authorizations.sql) that
// joins the client name and computes scheduled+completed shift hours
// within each authorization's own period. No own-row carve-out here -
// unlike shifts/credentials, an authorization isn't tied to a specific
// staff member, so visibility is a straight authorizations.read check.
interface AuthorizationRow {
  id: string;
  client_id: string;
  client_name: string;
  payer: string;
  authorized_hours: number;
  period_start: string;
  period_end: string;
  notes: string | null;
  scheduled_hours: number;
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
}

const statusStyles: Record<UtilizationStatus, string> = {
  under: "bg-amber-50 text-amber-700",
  on_track: "bg-emerald-50 text-emerald-700",
  over: "bg-red-50 text-red-700"
};

const statusLabels: Record<UtilizationStatus, string> = {
  under: "Under authorized hours",
  on_track: "On track",
  over: "Over authorized hours"
};

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

const emptyForm = {
  clientId: "",
  payer: "",
  authorizedHours: "",
  periodStart: "",
  periodEnd: "",
  notes: ""
};

export function AuthorizationsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("authorizations.read");
  const canManage = hasPermission("authorizations.update");

  const authorizationsQuery = useQuery({
    queryKey: ["authorizations", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_authorizations", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuthorizationRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const clientsQuery = useQuery({
    queryKey: ["clients-for-authorizations", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, first_name, last_name")
        .eq("organization_id", activeOrganizationId!)
        .order("last_name");
      if (error) throw error;
      return (data ?? []) as ClientOption[];
    },
    enabled: !!activeOrganizationId && canManage
  });

  function refreshAuthorizations() {
    void queryClient.invalidateQueries({ queryKey: ["authorizations", activeOrganizationId] });
  }

  const table = useTableControls<AuthorizationRow, "client" | "period" | "status">(authorizationsQuery.data, {
    matchesSearch: (row, query) =>
      row.client_name.toLowerCase().includes(query) || row.payer.toLowerCase().includes(query),
    sorters: {
      client: (a, b) => a.client_name.localeCompare(b.client_name),
      period: (a, b) => new Date(b.period_start).getTime() - new Date(a.period_start).getTime(),
      status: (a, b) =>
        getUtilizationStatus(a.authorized_hours, a.scheduled_hours).localeCompare(
          getUtilizationStatus(b.authorized_hours, b.scheduled_hours)
        )
    },
    defaultSort: "period"
  });

  const columns = useColumnWidths("carelik:column-widths:authorizations", {
    client: 160,
    payer: 150,
    period: 200,
    authorized: 110,
    scheduled: 110,
    status: 170
  });

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    setForm(emptyForm);
    setEditingId(null);
  }, [activeOrganizationId]);

  function startEdit(row: AuthorizationRow) {
    setEditingId(row.id);
    setForm({
      clientId: row.client_id,
      payer: row.payer,
      authorizedHours: String(row.authorized_hours),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      notes: row.notes ?? ""
    });
    setFormError(null);
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setFormError(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setFormError(null);

    const hours = Number(form.authorizedHours);
    if (Number.isNaN(hours) || hours < 0) {
      setFormError("Authorized hours must be a non-negative number.");
      return;
    }
    if (new Date(form.periodEnd).getTime() <= new Date(form.periodStart).getTime()) {
      setFormError("Period end must be after period start.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        organization_id: activeOrganizationId,
        client_id: form.clientId,
        payer: form.payer,
        authorized_hours: hours,
        period_start: form.periodStart,
        period_end: form.periodEnd,
        notes: form.notes || null
      };

      const { error } = editingId
        ? await supabase.from("client_authorizations").update(payload).eq("id", editingId)
        : await supabase.from("client_authorizations").insert(payload);
      if (error) throw error;

      resetForm();
      refreshAuthorizations();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save authorization.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(row: AuthorizationRow) {
    setRowError(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase
        .from("client_authorizations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw error;
      if (editingId === row.id) resetForm();
      refreshAuthorizations();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not remove authorization.");
    } finally {
      setPendingId(null);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Authorizations</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view client authorizations for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Authorizations</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Client authorizations"}
        </h2>
      </div>

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            {editingId ? "Edit authorization" : "Add an authorization"}
          </h3>
          <form onSubmit={handleSave} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="auth-client" className="block text-xs font-medium text-slate-600">
                Client
              </label>
              <select
                id="auth-client"
                required
                value={form.clientId}
                onChange={(event) => setForm({ ...form, clientId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select a client
                </option>
                {(clientsQuery.data ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.first_name} {client.last_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="auth-payer" className="block text-xs font-medium text-slate-600">
                Payer
              </label>
              <input
                id="auth-payer"
                required
                placeholder="e.g. Medicaid"
                value={form.payer}
                onChange={(event) => setForm({ ...form, payer: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="auth-hours" className="block text-xs font-medium text-slate-600">
                Authorized hours
              </label>
              <input
                id="auth-hours"
                type="number"
                min={0}
                step={0.5}
                required
                value={form.authorizedHours}
                onChange={(event) => setForm({ ...form, authorizedHours: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="auth-period-start" className="block text-xs font-medium text-slate-600">
                  Period start
                </label>
                <input
                  id="auth-period-start"
                  type="date"
                  required
                  value={form.periodStart}
                  onChange={(event) => setForm({ ...form, periodStart: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="auth-period-end" className="block text-xs font-medium text-slate-600">
                  Period end
                </label>
                <input
                  id="auth-period-end"
                  type="date"
                  required
                  value={form.periodEnd}
                  onChange={(event) => setForm({ ...form, periodEnd: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="auth-notes" className="block text-xs font-medium text-slate-600">
                Notes
              </label>
              <input
                id="auth-notes"
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="flex items-end gap-3 sm:col-span-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving…" : editingId ? "Save changes" : "Add authorization"}
              </button>
              {editingId ? (
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All authorizations</h3>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search client or payer"
            aria-label="Search authorizations"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {authorizationsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : authorizationsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load authorizations.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="Client"
                  active={table.sortKey === "client"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("client")}
                  width={columns.widths.client}
                  onResizeStart={columns.startResize("client")}
                />
                <PlainHeader
                  label="Payer"
                  width={columns.widths.payer}
                  onResizeStart={columns.startResize("payer")}
                />
                <SortableHeader
                  label="Period"
                  active={table.sortKey === "period"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("period")}
                  width={columns.widths.period}
                  onResizeStart={columns.startResize("period")}
                />
                <PlainHeader
                  label="Authorized"
                  width={columns.widths.authorized}
                  onResizeStart={columns.startResize("authorized")}
                />
                <PlainHeader
                  label="Scheduled"
                  width={columns.widths.scheduled}
                  onResizeStart={columns.startResize("scheduled")}
                />
                <SortableHeader
                  label="Status"
                  active={table.sortKey === "status"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("status")}
                  width={columns.widths.status}
                  onResizeStart={columns.startResize("status")}
                />
                {canManage ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                const status = getUtilizationStatus(row.authorized_hours, row.scheduled_hours);
                const active = isAuthorizationActive(row.period_start, row.period_end);
                return (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">{row.client_name}</td>
                    <td className="py-2.5 text-slate-600">{row.payer}</td>
                    <td className="py-2.5 whitespace-nowrap text-slate-600">
                      {new Date(row.period_start).toLocaleDateString()} –{" "}
                      {new Date(row.period_end).toLocaleDateString()}
                      {!active ? <span className="ml-1.5 text-xs text-slate-400">(past/future)</span> : null}
                    </td>
                    <td className="py-2.5 text-slate-600">{formatHours(row.authorized_hours)}h</td>
                    <td className="py-2.5 text-slate-600">{formatHours(row.scheduled_hours)}h</td>
                    <td className="py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[status]}`}>
                        {statusLabels[status]}
                      </span>
                    </td>
                    {canManage ? (
                      <td className="py-2.5 text-right">
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => startEdit(row)}
                            className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={pendingId === row.id}
                            onClick={() => handleRemove(row)}
                            className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 7 : 6} className="py-4 text-center text-slate-400">
                    {table.search ? "No authorizations match your search." : "No authorizations tracked yet."}
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
