import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { clientStatusSchema } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

interface ClientRow {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
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

  function startEdit(row: ClientRow) {
    setEditingId(row.id);
    setForm({
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone ?? "",
      email: row.email ?? "",
      address: row.address ?? "",
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
    if (!activeOrganizationId) return;

    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        organization_id: activeOrganizationId,
        first_name: form.firstName,
        last_name: form.lastName,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        care_notes: form.careNotes || null,
        status: form.status
      };

      const { error } = editingId
        ? await supabase.from("clients").update(payload).eq("id", editingId)
        : await supabase.from("clients").insert(payload);
      if (error) throw error;

      resetForm();
      refreshClients();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save client.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(row: ClientRow) {
    setRowError(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw error;
      if (editingId === row.id) resetForm();
      refreshClients();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not remove client.");
    } finally {
      setPendingId(null);
    }
  }

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
          <form onSubmit={handleSave} className="mt-4 grid gap-3 sm:grid-cols-2">
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
                Address
              </label>
              <input
                id="client-address"
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="client-notes" className="block text-xs font-medium text-slate-600">
                Care notes
              </label>
              <textarea
                id="client-notes"
                rows={3}
                value={form.careNotes}
                onChange={(event) => setForm({ ...form, careNotes: event.target.value })}
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
            <div className="flex items-end gap-3 sm:col-span-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving…" : editingId ? "Save changes" : "Add client"}
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
        <h3 className="font-semibold text-slate-950">All clients</h3>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {clientsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : clientsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load clients.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Phone</th>
                <th className="pb-2 font-medium">Status</th>
                {canManage ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {(clientsQuery.data ?? []).map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 text-slate-800">
                    {row.first_name} {row.last_name}
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
              {(clientsQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 4 : 3} className="py-4 text-center text-slate-400">
                    No clients yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
