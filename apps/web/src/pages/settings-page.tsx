import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAuth } from "@carelik/auth";
import { supabase } from "@/lib/supabase";

// public.organization_settings is a generic (organization_id, key) -> jsonb
// store - there's no fixed list of settings, so this page is a generic
// editor over whatever keys exist, rather than a form with named fields.
interface SettingRow {
  organization_id: string;
  key: string;
  value: unknown;
  version: number;
  updated_by: string | null;
  updated_at: string;
}

function previewValue(value: unknown) {
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function SettingsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canRead = hasPermission("settings.read");
  const canUpdate = hasPermission("settings.update");

  const settingsQuery = useQuery({
    queryKey: ["organization-settings", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organization_settings")
        .select("*")
        .eq("organization_id", activeOrganizationId!)
        .order("key");
      if (error) throw error;
      return (data ?? []) as SettingRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  function refreshSettings() {
    void queryClient.invalidateQueries({ queryKey: ["organization-settings", activeOrganizationId] });
  }

  const [key, setKey] = useState("");
  const [valueText, setValueText] = useState("");
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  function startEdit(row: SettingRow) {
    setKey(row.key);
    setValueText(JSON.stringify(row.value, null, 2));
    setEditingVersion(row.version);
    setFormError(null);
  }

  function resetForm() {
    setKey("");
    setValueText("");
    setEditingVersion(null);
    setFormError(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId || !user) return;

    setFormError(null);

    let parsedValue: unknown;
    try {
      parsedValue = valueText.trim() === "" ? null : JSON.parse(valueText);
    } catch {
      setFormError("Value must be valid JSON (e.g. \"a string\", 42, true, or {\"a\":1}).");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("organization_settings")
        .upsert(
          {
            organization_id: activeOrganizationId,
            key,
            value: parsedValue,
            version: (editingVersion ?? 0) + 1,
            updated_by: user.id,
            updated_at: new Date().toISOString()
          },
          { onConflict: "organization_id,key" }
        );
      if (error) throw error;
      resetForm();
      refreshSettings();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save setting.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row: SettingRow) {
    if (!activeOrganizationId) return;
    setRowError(null);
    setPendingKey(row.key);
    try {
      const { error } = await supabase
        .from("organization_settings")
        .delete()
        .eq("organization_id", activeOrganizationId)
        .eq("key", row.key);
      if (error) throw error;
      if (editingVersion !== null && key === row.key) resetForm();
      refreshSettings();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not delete setting.");
    } finally {
      setPendingKey(null);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Settings</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view settings for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Settings</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Organization settings"}
        </h2>
      </div>

      {canUpdate ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            {editingVersion !== null ? `Edit “${key}”` : "Add a setting"}
          </h3>
          <form onSubmit={handleSave} className="mt-4 space-y-3">
            <div>
              <label htmlFor="setting-key" className="block text-xs font-medium text-slate-600">
                Key
              </label>
              <input
                id="setting-key"
                required
                disabled={editingVersion !== null}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="notifications.default_channel"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
              />
            </div>
            <div>
              <label htmlFor="setting-value" className="block text-xs font-medium text-slate-600">
                Value (JSON)
              </label>
              <textarea
                id="setting-value"
                required
                rows={4}
                value={valueText}
                onChange={(event) => setValueText(event.target.value)}
                placeholder='"a string", 42, true, or {"key": "value"}'
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm text-slate-900"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving…" : editingVersion !== null ? "Save changes" : "Add setting"}
              </button>
              {editingVersion !== null ? (
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
        <h3 className="font-semibold text-slate-950">Stored settings</h3>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {settingsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : settingsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load settings.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Key</th>
                <th className="pb-2 font-medium">Value</th>
                <th className="pb-2 font-medium">Updated</th>
                {canUpdate ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {(settingsQuery.data ?? []).map((row) => (
                <tr key={row.key} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 font-mono text-xs text-slate-800">{row.key}</td>
                  <td className="py-2.5 font-mono text-xs text-slate-600">{previewValue(row.value)}</td>
                  <td className="py-2.5 text-slate-500">
                    {new Date(row.updated_at).toLocaleString()}
                  </td>
                  {canUpdate ? (
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
                          disabled={pendingKey === row.key}
                          onClick={() => handleDelete(row)}
                          className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {(settingsQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={canUpdate ? 4 : 3} className="py-4 text-center text-slate-400">
                    No settings yet.
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
