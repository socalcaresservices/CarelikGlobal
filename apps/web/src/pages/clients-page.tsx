import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Clipboard } from "lucide-react";
import { Button, Card, EmptyState, FormSection, FilterBar, type ActiveFilter } from "@carelik/ui";
import { clientStatusSchema } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { getSaveErrorMessage } from "@/lib/data-errors";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

interface ClientRow {
  id: string;
  client_code: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  care_notes: string | null;
  status: "active" | "inactive" | "discharged";
}

const statusStyles: Record<ClientRow["status"], string> = {
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-slate-100 text-slate-600",
  discharged: "bg-amber-50 text-amber-700"
};

const emptyForm = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  address: "",
  addressLine2: "",
  addressCity: "",
  addressState: "",
  addressZip: "",
  careNotes: "",
  status: "active" as ClientRow["status"]
};

export function ClientsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("clients.read");
  const canManage = hasPermission("clients.update");

  const clientsQuery = useQuery({
    queryKey: ["clients", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .eq("organization_id", activeOrganizationId!)
        .order("last_name");
      if (error) throw error;
      return (data ?? []) as ClientRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  function refreshClients() {
    void queryClient.invalidateQueries({ queryKey: ["clients", activeOrganizationId] });
  }

  // The "Add a client" form already sits on this page (see the Card just
  // below), always rendered rather than behind a toggle - so the empty
  // state's call to action doesn't need its own modal or route, it just
  // needs to get the user's eyes and cursor there.
  function focusAddClientForm() {
    document.getElementById("client-first-name")?.focus();
  }

  function downloadClientsAsCSV() {
    if (!table.rows.length) return;
    const orgName = activeOrganization?.displayName ?? "clients";
    const timestamp = new Date().toISOString().split("T")[0];
    const filename = `${orgName}-clients-${timestamp}.csv`;

    const rows = table.rows.map((client) => [
      `${client.first_name} ${client.last_name}`,
      client.client_code,
      client.phone ?? "",
      client.email ?? "",
      client.status
    ]);

    const csvContent = [
      ["Name", "Client ID", "Phone", "Email", "Status"],
      ...rows
    ]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const filters = useFilters<ClientRow>(clientsQuery.data, {
    status: (row, value) => row.status === value
  });

  const table = useTableControls<ClientRow, "name" | "status">(filters.rows, {
    matchesSearch: (row, query) =>
      `${row.first_name} ${row.last_name}`.toLowerCase().includes(query) ||
      row.client_code.toLowerCase().includes(query) ||
      (row.phone ?? "").toLowerCase().includes(query) ||
      (row.email ?? "").toLowerCase().includes(query),
    sorters: {
      name: (a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
      status: (a, b) => a.status.localeCompare(b.status)
    }
  });

  const columns = useColumnWidths("carelik:column-widths:clients", {
    name: 220,
    clientId: 140,
    phone: 140,
    status: 130
  });

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowSuccess, setRowSuccess] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [copiedClientId, setCopiedClientId] = useState<string | null>(null);

  async function copyClientId(clientCode: string) {
    try {
      await navigator.clipboard.writeText(clientCode);
      setCopiedClientId(clientCode);
      window.setTimeout(() => setCopiedClientId((current) => (current === clientCode ? null : current)), 1800);
    } catch {
      setRowError(`Could not copy to clipboard. Client ID: ${clientCode}`);
    }
  }

  useEffect(() => {
    setForm(emptyForm);
    setEditingId(null);
  }, [activeOrganizationId]);

  // Auto-clear success messages after 3 seconds
  useEffect(() => {
    if (rowSuccess) {
      const timeout = setTimeout(() => setRowSuccess(null), 3000);
      return () => clearTimeout(timeout);
    }
  }, [rowSuccess]);

  function startEdit(row: ClientRow) {
    setEditingId(row.id);
    setForm({
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone ?? "",
      email: row.email ?? "",
      address: row.address ?? "",
      addressLine2: row.address_line2 ?? "",
      addressCity: row.address_city ?? "",
      addressState: row.address_state ?? "",
      addressZip: row.address_zip ?? "",
      careNotes: row.care_notes ?? "",
      status: row.status
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
    if (!activeOrganizationId) {
      setFormError("No organization is selected. Reload the page and confirm you're in the right organization before saving.");
      return;
    }

    setFormError(null);
    setRowSuccess(null);
    setSaving(true);
    try {
      const payload = {
        organization_id: activeOrganizationId,
        first_name: form.firstName,
        last_name: form.lastName,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        address_line2: form.addressLine2 || null,
        address_city: form.addressCity || null,
        address_state: form.addressState || null,
        address_zip: form.addressZip || null,
        care_notes: form.careNotes || null,
        status: form.status
      };

      const isCreate = !editingId;
      const { error } = editingId
        ? await supabase.from("clients").update(payload).eq("id", editingId)
        : await supabase.from("clients").insert(payload);
      if (error) throw error;

      setRowSuccess(isCreate ? `Added ${form.firstName} ${form.lastName}.` : "Client updated.");
      resetForm();
      refreshClients();
    } catch (cause) {
      setFormError(getSaveErrorMessage(cause, "Could not save client."));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(row: ClientRow) {
    setRowError(null);
    setRowSuccess(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw error;
      setRowSuccess(`Removed ${row.first_name} ${row.last_name}.`);
      if (editingId === row.id) resetForm();
      refreshClients();
    } catch (cause) {
      setRowError(getSaveErrorMessage(cause, "Could not remove client."));
    } finally {
      setPendingId(null);
    }
  }

  const clientActiveFilters: ActiveFilter[] = filters.values.status
    ? [
        {
          key: "status",
          label: `Status: ${filters.values.status}`,
          onRemove: () => filters.setFilter("status", "")
        }
      ]
    : [];

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Clients</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view client records for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Clients</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Client records"}
        </h2>
      </div>

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            {editingId ? "Edit client" : "Add a client"}
          </h3>
          <form onSubmit={handleSave} className="mt-4 space-y-5">
            <FormSection title="Basic information" columns={2}>
              <div>
                <label htmlFor="client-first-name" className="block text-xs font-medium text-slate-600">
                  First name
                </label>
                <input
                  id="client-first-name"
                  required
                  value={form.firstName}
                  onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-last-name" className="block text-xs font-medium text-slate-600">
                  Last name
                </label>
                <input
                  id="client-last-name"
                  required
                  value={form.lastName}
                  onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-status" className="block text-xs font-medium text-slate-600">
                  Status
                </label>
                <select
                  id="client-status"
                  value={form.status}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as ClientRow["status"] })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                >
                  {clientStatusSchema.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </FormSection>

            <FormSection title="Contact information" columns={2}>
              <div>
                <label htmlFor="client-phone" className="block text-xs font-medium text-slate-600">
                  Phone
                </label>
                <input
                  id="client-phone"
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-email" className="block text-xs font-medium text-slate-600">
                  Email
                </label>
                <input
                  id="client-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="client-address" className="block text-xs font-medium text-slate-600">
                  Street address
                </label>
                <input
                  id="client-address"
                  value={form.address}
                  onChange={(event) => setForm({ ...form, address: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="client-address-line2" className="block text-xs font-medium text-slate-600">
                  Address line 2
                </label>
                <input
                  id="client-address-line2"
                  value={form.addressLine2}
                  onChange={(event) => setForm({ ...form, addressLine2: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-address-city" className="block text-xs font-medium text-slate-600">
                  City
                </label>
                <input
                  id="client-address-city"
                  value={form.addressCity}
                  onChange={(event) => setForm({ ...form, addressCity: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-address-state" className="block text-xs font-medium text-slate-600">
                  State
                </label>
                <input
                  id="client-address-state"
                  value={form.addressState}
                  onChange={(event) => setForm({ ...form, addressState: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="client-address-zip" className="block text-xs font-medium text-slate-600">
                  ZIP code
                </label>
                <input
                  id="client-address-zip"
                  value={form.addressZip}
                  onChange={(event) => setForm({ ...form, addressZip: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </FormSection>

            <FormSection title="Care notes" columns={1}>
              <textarea
                id="client-notes"
                aria-label="Care notes"
                rows={3}
                value={form.careNotes}
                onChange={(event) => setForm({ ...form, careNotes: event.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </FormSection>

            <div className="flex items-end gap-3">
              <Button type="submit" loading={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Add client"}
              </Button>
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
          <h3 className="font-semibold text-slate-950">All clients</h3>
          <div className="flex flex-wrap items-center gap-2">
            {table.rows.length > 0 && (
              <button
                type="button"
                onClick={downloadClientsAsCSV}
                className="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Download as CSV
              </button>
            )}
              <FilterBar
                activeFilters={clientActiveFilters}
                onClearAll={clientActiveFilters.length > 0 ? filters.clearAll : undefined}
                className="w-full sm:w-auto"
              >
                <input
                  type="search"
                  value={table.search}
                  onChange={(event) => table.setSearch(event.target.value)}
                  placeholder="Search name, Client ID, phone, or email"
                  aria-label="Search clients"
                  className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                />
                <div>
                  <label htmlFor="client-status-filter" className="sr-only">
                    Filter by status
                  </label>
                  <select
                    id="client-status-filter"
                    value={filters.values.status ?? ""}
                    onChange={(event) => filters.setFilter("status", event.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                  >
                    <option value="">All statuses</option>
                    {clientStatusSchema.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </FilterBar>
            </div>
          </div>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {rowSuccess ? <p className="mt-2 text-sm text-emerald-700">{rowSuccess}</p> : null}
        {clientsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : clientsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load clients.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="Name"
                  active={table.sortKey === "name"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("name")}
                  width={columns.widths.name}
                  onResizeStart={columns.startResize("name")}
                />
                <PlainHeader
                  label="Client ID"
                  width={columns.widths.clientId}
                  onResizeStart={columns.startResize("clientId")}
                />
                <PlainHeader
                  label="Phone"
                  width={columns.widths.phone}
                  onResizeStart={columns.startResize("phone")}
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
              {table.rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 text-slate-800">
                    <Link to={`/clients/${row.id}`} className="hover:underline">
                      {row.first_name} {row.last_name}
                    </Link>
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-slate-600">{row.client_code}</span>
                      <button
                        type="button"
                        onClick={() => void copyClientId(row.client_code)}
                        aria-label={`Copy Client ID for ${row.first_name} ${row.last_name}`}
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                      </button>
                      {copiedClientId === row.client_code ? <span className="text-xs text-emerald-700">Copied</span> : null}
                    </div>
                  </td>
                  <td className="py-2.5 text-slate-500">{row.phone ?? "—"}</td>
                  <td className="py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[row.status]}`}>
                      {row.status}
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
              ))}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 5 : 4}>
                    {table.search || clientActiveFilters.length > 0 ? (
                      <EmptyState message="No clients match your search or filters." />
                    ) : (
                      <EmptyState
                        message="You're ready to add your first client. Fill in their details above and they'll show up here."
                        action={
                          canManage ? (
                            <Button variant="secondary" size="sm" onClick={focusAddClientForm}>
                              Add your first client
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
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
