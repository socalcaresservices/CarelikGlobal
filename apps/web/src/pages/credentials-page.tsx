import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { getCredentialStatus, type CredentialStatus } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Backed by list_caregiver_credentials(), a security-definer RPC (see
// supabase/migrations/20260719250000_caregiver_credentials.sql) that
// resolves caregiver names server-side, same reason list_shifts() does -
// RLS on user_profiles only allows reading your own row. Access mirrors
// the table's RLS: org-wide with credentials.read, or just your own.
interface CredentialRow {
  id: string;
  caregiver_user_id: string;
  caregiver_name: string;
  credential_type: string;
  issued_date: string | null;
  expires_at: string | null;
  notes: string | null;
}

interface MemberOption {
  user_id: string;
  display_name: string;
}

const statusStyles: Record<CredentialStatus, string> = {
  no_expiration: "bg-slate-100 text-slate-600",
  active: "bg-emerald-50 text-emerald-700",
  expiring_soon: "bg-amber-50 text-amber-700",
  expired: "bg-red-50 text-red-700"
};

const statusLabels: Record<CredentialStatus, string> = {
  no_expiration: "No expiration",
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired"
};

const emptyForm = {
  caregiverUserId: "",
  credentialType: "",
  issuedDate: "",
  expiresAt: "",
  notes: ""
};

export function CredentialsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("credentials.read");
  const canManage = hasPermission("credentials.update");

  const credentialsQuery = useQuery({
    queryKey: ["credentials", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_credentials", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    },
    enabled: !!activeOrganizationId
  });

  const membersQuery = useQuery({
    queryKey: ["members-for-credentials", activeOrganizationId],
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

  function refreshCredentials() {
    void queryClient.invalidateQueries({ queryKey: ["credentials", activeOrganizationId] });
  }

  const table = useTableControls<CredentialRow, "caregiver" | "type" | "expires">(credentialsQuery.data, {
    matchesSearch: (row, query) =>
      row.caregiver_name.toLowerCase().includes(query) || row.credential_type.toLowerCase().includes(query),
    sorters: {
      caregiver: (a, b) => a.caregiver_name.localeCompare(b.caregiver_name),
      type: (a, b) => a.credential_type.localeCompare(b.credential_type),
      expires: (a, b) => {
        if (!a.expires_at && !b.expires_at) return 0;
        if (!a.expires_at) return 1;
        if (!b.expires_at) return -1;
        return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
      }
    },
    defaultSort: "expires"
  });

  const columns = useColumnWidths("carelik:column-widths:credentials", {
    caregiver: 180,
    type: 180,
    expires: 130,
    status: 150
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

  function startEdit(row: CredentialRow) {
    setEditingId(row.id);
    setForm({
      caregiverUserId: row.caregiver_user_id,
      credentialType: row.credential_type,
      issuedDate: row.issued_date ?? "",
      expiresAt: row.expires_at ?? "",
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
    setSaving(true);
    try {
      const payload = {
        organization_id: activeOrganizationId,
        caregiver_user_id: form.caregiverUserId,
        credential_type: form.credentialType,
        issued_date: form.issuedDate || null,
        expires_at: form.expiresAt || null,
        notes: form.notes || null
      };

      const { error } = editingId
        ? await supabase.from("caregiver_credentials").update(payload).eq("id", editingId)
        : await supabase.from("caregiver_credentials").insert(payload);
      if (error) throw error;

      resetForm();
      refreshCredentials();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save credential.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(row: CredentialRow) {
    setRowError(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase
        .from("caregiver_credentials")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw error;
      if (editingId === row.id) resetForm();
      refreshCredentials();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not remove credential.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Credentials</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Caregiver credentials"}
        </h2>
        {!canRead ? (
          <p className="mt-1 text-sm text-slate-500">Showing only your own credentials.</p>
        ) : null}
      </div>

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">{editingId ? "Edit credential" : "Add a credential"}</h3>
          <form onSubmit={handleSave} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="credential-caregiver" className="block text-xs font-medium text-slate-600">
                Caregiver
              </label>
              <select
                id="credential-caregiver"
                required
                value={form.caregiverUserId}
                onChange={(event) => setForm({ ...form, caregiverUserId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select a caregiver
                </option>
                {(membersQuery.data ?? []).map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="credential-type" className="block text-xs font-medium text-slate-600">
                Credential
              </label>
              <input
                id="credential-type"
                required
                placeholder="e.g. CPR Certification"
                value={form.credentialType}
                onChange={(event) => setForm({ ...form, credentialType: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="credential-issued" className="block text-xs font-medium text-slate-600">
                Issued date
              </label>
              <input
                id="credential-issued"
                type="date"
                value={form.issuedDate}
                onChange={(event) => setForm({ ...form, issuedDate: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="credential-expires" className="block text-xs font-medium text-slate-600">
                Expires (leave blank if it doesn&apos;t expire)
              </label>
              <input
                id="credential-expires"
                type="date"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="credential-notes" className="block text-xs font-medium text-slate-600">
                Notes
              </label>
              <input
                id="credential-notes"
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
                {saving ? "Saving…" : editingId ? "Save changes" : "Add credential"}
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
          <h3 className="font-semibold text-slate-950">All credentials</h3>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search caregiver or credential"
            aria-label="Search credentials"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {credentialsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : credentialsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load credentials.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="Caregiver"
                  active={table.sortKey === "caregiver"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("caregiver")}
                  width={columns.widths.caregiver}
                  onResizeStart={columns.startResize("caregiver")}
                />
                <SortableHeader
                  label="Credential"
                  active={table.sortKey === "type"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("type")}
                  width={columns.widths.type}
                  onResizeStart={columns.startResize("type")}
                />
                <SortableHeader
                  label="Expires"
                  active={table.sortKey === "expires"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("expires")}
                  width={columns.widths.expires}
                  onResizeStart={columns.startResize("expires")}
                />
                <PlainHeader
                  label="Status"
                  width={columns.widths.status}
                  onResizeStart={columns.startResize("status")}
                />
                {canManage ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                const status = getCredentialStatus(row.expires_at);
                return (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">{row.caregiver_name}</td>
                    <td className="py-2.5 text-slate-600">{row.credential_type}</td>
                    <td className="py-2.5 text-slate-600">
                      {row.expires_at ? new Date(row.expires_at).toLocaleDateString() : "—"}
                    </td>
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
                  <td colSpan={canManage ? 5 : 4} className="py-4 text-center text-slate-400">
                    {table.search ? "No credentials match your search." : "No credentials tracked yet."}
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
