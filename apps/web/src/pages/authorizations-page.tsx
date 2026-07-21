import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  FormSection,
  SearchableCombobox,
  StatusBadge,
  type ComboboxOption,
  type StatusTone
} from "@carelik/ui";
import {
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  isAuthorizationActive,
  type AuthorizationExpiryStatus,
  type AuthorizationUsageStatus
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Backed by list_client_authorizations(), a security-definer RPC (see
// supabase/migrations/20260721010000_services_and_authorization_usage.sql)
// that joins the client/service names and computes two numbers scoped to
// the current calendar month - hours_used_this_month (completed shifts)
// and hours_scheduled_this_month (scheduled shifts) - clamped to the
// overlap of "this month" and the authorization's own validity period.
// Usage status (normal/approaching/at limit/over limit) and expiry
// status (active/expiring soon/expired) are both derived client-side
// from these raw numbers, never stored.
interface AuthorizationRow {
  id: string;
  client_id: string;
  client_name: string;
  service_id: string;
  service_name: string;
  payer: string;
  authorization_number: string | null;
  max_monthly_hours: number;
  period_start: string;
  period_end: string;
  notes: string | null;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
}

interface ServiceRow {
  id: string;
  name: string;
  is_active: boolean;
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

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

const emptyForm = {
  clientId: "",
  serviceId: "",
  payer: "",
  authorizationNumber: "",
  maxMonthlyHours: "",
  periodStart: "",
  periodEnd: "",
  notes: ""
};

export function AuthorizationsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  // A client can arrive with ?clientId= already set (see the "Add
  // authorization" link on the Client detail page's Authorizations
  // tab), so the client field is pre-filled and locked instead of
  // making the person re-pick the client they just came from.
  const [searchParams] = useSearchParams();
  const lockedClientId = searchParams.get("clientId");

  const canRead = hasPermission("authorizations.read");
  const canManage = hasPermission("authorizations.update");
  const canManageServices = hasPermission("services.update");

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

  function refreshAuthorizations() {
    void queryClient.invalidateQueries({ queryKey: ["authorizations", activeOrganizationId] });
  }

  function refreshServices() {
    void queryClient.invalidateQueries({ queryKey: ["services", activeOrganizationId] });
  }

  const table = useTableControls<AuthorizationRow, "client" | "period" | "usage">(authorizationsQuery.data, {
    matchesSearch: (row, query) =>
      row.client_name.toLowerCase().includes(query) ||
      row.service_name.toLowerCase().includes(query) ||
      row.payer.toLowerCase().includes(query) ||
      (row.authorization_number ?? "").toLowerCase().includes(query),
    sorters: {
      client: (a, b) => a.client_name.localeCompare(b.client_name),
      period: (a, b) => new Date(b.period_start).getTime() - new Date(a.period_start).getTime(),
      usage: (a, b) =>
        getAuthorizationUsageStatus(a.max_monthly_hours, a.hours_used_this_month, a.hours_scheduled_this_month).localeCompare(
          getAuthorizationUsageStatus(b.max_monthly_hours, b.hours_used_this_month, b.hours_scheduled_this_month)
        )
    },
    defaultSort: "period"
  });

  const columns = useColumnWidths("carelik:column-widths:authorizations", {
    client: 150,
    service: 130,
    payer: 140,
    period: 190,
    capacity: 90,
    thisMonth: 150,
    usage: 140,
    expiry: 120
  });

  const [form, setForm] = useState(() => ({ ...emptyForm, clientId: lockedClientId ?? "" }));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [serviceName, setServiceName] = useState("");
  const [serviceSaving, setServiceSaving] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  useEffect(() => {
    setForm({ ...emptyForm, clientId: lockedClientId ?? "" });
    setEditingId(null);
  }, [activeOrganizationId, lockedClientId]);

  const clientOptions: ComboboxOption[] = (clientsQuery.data ?? []).map((client) => ({
    value: client.id,
    label: `${client.first_name} ${client.last_name}`
  }));

  const editingRow = editingId ? (authorizationsQuery.data ?? []).find((row) => row.id === editingId) : undefined;

  const serviceOptions: ComboboxOption[] = (() => {
    const active: ComboboxOption[] = (servicesQuery.data ?? [])
      .filter((service) => service.is_active)
      .map((service) => ({ value: service.id, label: service.name }));
    if (editingRow && !active.some((option) => option.value === editingRow.service_id)) {
      active.push({ value: editingRow.service_id, label: editingRow.service_name, description: "inactive" });
    }
    return active;
  })();

  function startEdit(row: AuthorizationRow) {
    setEditingId(row.id);
    setForm({
      clientId: row.client_id,
      serviceId: row.service_id,
      payer: row.payer,
      authorizationNumber: row.authorization_number ?? "",
      maxMonthlyHours: String(row.max_monthly_hours),
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

    if (!form.clientId) {
      setFormError("Select a client.");
      return;
    }
    if (!form.serviceId) {
      setFormError("Select a service.");
      return;
    }
    const hours = Number(form.maxMonthlyHours);
    if (Number.isNaN(hours) || hours < 0) {
      setFormError("Max monthly hours must be a non-negative number.");
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
        service_id: form.serviceId,
        payer: form.payer,
        authorization_number: form.authorizationNumber || null,
        max_monthly_hours: hours,
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

  async function handleAddService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    const trimmed = serviceName.trim();
    if (!trimmed) return;

    setServiceError(null);
    setServiceSaving(true);
    try {
      const { error } = await supabase.from("services").insert({
        organization_id: activeOrganizationId,
        name: trimmed
      });
      if (error) throw error;
      setServiceName("");
      refreshServices();
    } catch (cause) {
      setServiceError(cause instanceof Error ? cause.message : "Could not add service.");
    } finally {
      setServiceSaving(false);
    }
  }

  async function handleToggleServiceActive(service: ServiceRow) {
    setServiceError(null);
    try {
      const { error } = await supabase
        .from("services")
        .update({ is_active: !service.is_active })
        .eq("id", service.id);
      if (error) throw error;
      refreshServices();
      refreshAuthorizations();
    } catch (cause) {
      setServiceError(cause instanceof Error ? cause.message : "Could not update service.");
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-5xl">
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
    <section className="mx-auto max-w-5xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Authorizations</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Client authorizations"}
        </h2>
      </div>

      {canManageServices ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Services</h3>
          <p className="mt-1 text-xs text-slate-500">
            The billable service types authorizations are tracked against (Personal care, Companionship...).
            Deactivating a service keeps its history but hides it from new authorizations.
          </p>
          <form onSubmit={handleAddService} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label htmlFor="new-service-name" className="block text-xs font-medium text-slate-600">
                Service name
              </label>
              <input
                id="new-service-name"
                required
                placeholder="e.g. Personal care"
                value={serviceName}
                onChange={(event) => setServiceName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <button
              type="submit"
              disabled={serviceSaving}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {serviceSaving ? "Adding…" : "Add service"}
            </button>
          </form>
          {serviceError ? <p className="mt-2 text-sm text-red-700">{serviceError}</p> : null}
          {(servicesQuery.data ?? []).length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-2">
              {(servicesQuery.data ?? []).map((service) => (
                <li key={service.id}>
                  <button
                    type="button"
                    onClick={() => handleToggleServiceActive(service)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      service.is_active
                        ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                    title={service.is_active ? "Click to deactivate" : "Click to reactivate"}
                  >
                    {service.name} {service.is_active ? "" : "(inactive)"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-400">No services configured yet.</p>
          )}
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            {editingId ? "Edit authorization" : "Add an authorization"}
          </h3>
          <form onSubmit={handleSave} className="mt-4 space-y-5">
            <FormSection title="Who and what" columns={2}>
              <SearchableCombobox
                label="Client"
                required
                disabled={!!lockedClientId && !editingId}
                value={form.clientId || null}
                onChange={(value) => setForm({ ...form, clientId: value ?? "" })}
                options={clientOptions}
                selectedLabel={editingRow?.client_name}
                placeholder="Search clients…"
              />
              <SearchableCombobox
                label="Service"
                required
                value={form.serviceId || null}
                onChange={(value) => setForm({ ...form, serviceId: value ?? "" })}
                options={serviceOptions}
                selectedLabel={editingRow?.service_name}
                placeholder="Search services…"
              />
            </FormSection>

            <FormSection title="Authorization details" columns={2}>
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
                <label htmlFor="auth-number" className="block text-xs font-medium text-slate-600">
                  Authorization number
                </label>
                <input
                  id="auth-number"
                  placeholder="Optional"
                  value={form.authorizationNumber}
                  onChange={(event) => setForm({ ...form, authorizationNumber: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="auth-hours" className="block text-xs font-medium text-slate-600">
                  Max hours / month
                </label>
                <input
                  id="auth-hours"
                  type="number"
                  min={0}
                  step={0.5}
                  required
                  value={form.maxMonthlyHours}
                  onChange={(event) => setForm({ ...form, maxMonthlyHours: event.target.value })}
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
            </FormSection>

            <FormSection title="Notes" columns={1}>
              <input
                id="auth-notes"
                aria-label="Notes"
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </FormSection>

            <div className="flex items-end gap-3">
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
            {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
          </form>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All authorizations</h3>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search client, service, payer, or authorization #"
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
                  label="Service"
                  width={columns.widths.service}
                  onResizeStart={columns.startResize("service")}
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
                  label="Cap / mo"
                  width={columns.widths.capacity}
                  onResizeStart={columns.startResize("capacity")}
                />
                <PlainHeader
                  label="This month"
                  width={columns.widths.thisMonth}
                  onResizeStart={columns.startResize("thisMonth")}
                />
                <SortableHeader
                  label="Usage"
                  active={table.sortKey === "usage"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("usage")}
                  width={columns.widths.usage}
                  onResizeStart={columns.startResize("usage")}
                />
                <PlainHeader
                  label="Expiry"
                  width={columns.widths.expiry}
                  onResizeStart={columns.startResize("expiry")}
                />
                {canManage ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                const usage = getAuthorizationUsageStatus(
                  row.max_monthly_hours,
                  row.hours_used_this_month,
                  row.hours_scheduled_this_month
                );
                const expiry = getAuthorizationExpiryStatus(row.period_end);
                const active = isAuthorizationActive(row.period_start, row.period_end);
                return (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">{row.client_name}</td>
                    <td className="py-2.5 text-slate-600">{row.service_name}</td>
                    <td className="py-2.5 text-slate-600">
                      {row.payer}
                      {row.authorization_number ? (
                        <span className="block text-xs text-slate-400">#{row.authorization_number}</span>
                      ) : null}
                    </td>
                    <td className="py-2.5 whitespace-nowrap text-slate-600">
                      {new Date(row.period_start).toLocaleDateString()} –{" "}
                      {new Date(row.period_end).toLocaleDateString()}
                      {!active ? <span className="ml-1.5 text-xs text-slate-400">(past/future)</span> : null}
                    </td>
                    <td className="py-2.5 text-slate-600">{formatHours(row.max_monthly_hours)}h</td>
                    <td className="py-2.5 text-slate-600">
                      {formatHours(row.hours_used_this_month)}h used
                      <span className="block text-xs text-slate-400">
                        {formatHours(row.hours_scheduled_this_month)}h scheduled
                      </span>
                    </td>
                    <td className="py-2.5">
                      <StatusBadge label={usageLabelText[usage]} tone={usageTone[usage]} />
                    </td>
                    <td className="py-2.5">
                      <StatusBadge label={expiryLabelText[expiry]} tone={expiryTone[expiry]} />
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
                  <td colSpan={canManage ? 9 : 8} className="py-4 text-center text-slate-400">
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
