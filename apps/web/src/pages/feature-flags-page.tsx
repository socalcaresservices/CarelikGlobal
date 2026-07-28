import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, Button, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Feature flags (public.feature_flags, 20260715000100_platform_foundation.sql)
// have existed since the platform's first migration but never had a UI -
// the table, its RLS (read: any org member or the global/null-org row;
// write: platform owner only), and its schedule/configuration columns
// were all pure scaffolding until this build. Write access is
// platform-owner-only by design (see that migration's RLS policies) -
// this is a rollout-control tool for CareLik itself (per-org beta
// access, global kill switches), not a self-service organization
// setting, the same distinction organizations-page.tsx already draws
// between "manage your own org's profile" and "manage every tenant."
//
// null organization_id means a global flag (applies to every org unless
// that org has its own row for the same key, which wins - see
// use-feature-flag.ts for the read side of that precedence).
interface FeatureFlagRow {
  id: string;
  key: string;
  organization_id: string | null;
  enabled: boolean;
  configuration: unknown;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
}

interface FlagForm {
  key: string;
  organizationId: string;
  enabled: boolean;
  startsAt: string;
  endsAt: string;
  configurationText: string;
}

const emptyForm: FlagForm = {
  key: "",
  organizationId: "",
  enabled: false,
  startsAt: "",
  endsAt: "",
  configurationText: ""
};

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm", not a full ISO
  // string with seconds/timezone - slice rather than reformat with a date
  // library, since this only ever needs to round-trip through the browser's
  // own local-time picker, not display anywhere else.
  return iso.slice(0, 16);
}

export function FeatureFlagsPage() {
  const { organizations, isPlatformOwner } = useOrganization();
  const queryClient = useQueryClient();

  const flagsQuery = useQuery({
    queryKey: ["feature-flags"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_flags")
        .select("id, key, organization_id, enabled, configuration, starts_at, ends_at, updated_at")
        .order("key");
      if (error) throw error;
      return (data ?? []) as FeatureFlagRow[];
    },
    enabled: isPlatformOwner
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
  }

  const [form, setForm] = useState<FlagForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function startEdit(row: FeatureFlagRow) {
    setEditingId(row.id);
    setForm({
      key: row.key,
      organizationId: row.organization_id ?? "",
      enabled: row.enabled,
      startsAt: toDatetimeLocalValue(row.starts_at),
      endsAt: toDatetimeLocalValue(row.ends_at),
      configurationText: JSON.stringify(row.configuration ?? {}, null, 2)
    });
    setFormError(null);
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.key.trim()) return;

    let configuration: unknown = {};
    if (form.configurationText.trim() !== "") {
      try {
        configuration = JSON.parse(form.configurationText);
      } catch {
        setFormError('Configuration must be valid JSON (e.g. {} or {"rolloutPct":50}).');
        return;
      }
    }

    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        key: form.key.trim(),
        organization_id: form.organizationId || null,
        enabled: form.enabled,
        starts_at: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        ends_at: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        configuration
      };

      const { error } = editingId
        ? await supabase.from("feature_flags").update(payload).eq("id", editingId)
        : await supabase.from("feature_flags").insert(payload);
      if (error) throw error;

      resetForm();
      refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save this flag.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(row: FeatureFlagRow) {
    setRowError(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase.from("feature_flags").update({ enabled: !row.enabled }).eq("id", row.id);
      if (error) throw error;
      refresh();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not update this flag.");
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(row: FeatureFlagRow) {
    setRowError(null);
    setPendingId(row.id);
    try {
      const { error } = await supabase.from("feature_flags").delete().eq("id", row.id);
      if (error) throw error;
      if (editingId === row.id) resetForm();
      refresh();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not delete this flag.");
    } finally {
      setPendingId(null);
    }
  }

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can manage feature flags.</p>
        </Card>
      </section>
    );
  }

  const rows = flagsQuery.data ?? [];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Platform Administration</p>
        <h1 className="text-2xl font-semibold text-slate-950">Feature flags</h1>
        <p className="mt-1 text-sm text-slate-600">
          Control rollout of in-progress features per organization, or platform-wide. A global flag (no
          organization selected) applies everywhere unless that organization has its own row for the same key.
        </p>
      </div>

      <Card>
        <h3 className="font-semibold text-slate-950">{editingId ? "Edit flag" : "New flag"}</h3>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="flag-key" className="block text-xs font-medium text-slate-600">
                Key
              </label>
              <input
                id="flag-key"
                required
                disabled={!!editingId}
                value={form.key}
                onChange={(event) => setForm({ ...form, key: event.target.value })}
                placeholder="e.g. new_owner_dashboard"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
            <div>
              <label htmlFor="flag-org" className="block text-xs font-medium text-slate-600">
                Organization
              </label>
              <select
                id="flag-org"
                value={form.organizationId}
                onChange={(event) => setForm({ ...form, organizationId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">Global (every organization)</option>
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Enabled
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="flag-starts" className="block text-xs font-medium text-slate-600">
                Starts at (optional)
              </label>
              <input
                id="flag-starts"
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="flag-ends" className="block text-xs font-medium text-slate-600">
                Ends at (optional)
              </label>
              <input
                id="flag-ends"
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>

          <div>
            <label htmlFor="flag-config" className="block text-xs font-medium text-slate-600">
              Configuration (JSON, optional)
            </label>
            <textarea
              id="flag-config"
              rows={3}
              value={form.configurationText}
              onChange={(event) => setForm({ ...form, configurationText: event.target.value })}
              placeholder="{}"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
            />
          </div>

          {formError ? <p className="text-sm text-red-700">{formError}</p> : null}

          <div className="flex gap-2">
            <Button type="submit" loading={saving}>
              {editingId ? "Save changes" : "Create flag"}
            </Button>
            {editingId ? (
              <Button type="button" variant="secondary" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-950">All flags</h3>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {flagsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : flagsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load feature flags.</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No feature flags configured yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {rows.map((row) => {
              const scopeLabel = row.organization_id
                ? (organizations.find((org) => org.id === row.organization_id)?.displayName ?? "Unknown organization")
                : "Global";
              return (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{row.key}</p>
                    <p className="text-xs text-slate-500">{scopeLabel}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge label={row.enabled ? "Enabled" : "Disabled"} tone={row.enabled ? "success" : "neutral"} />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={pendingId === row.id}
                      onClick={() => toggleEnabled(row)}
                    >
                      {row.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(row)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={pendingId === row.id}
                      onClick={() => handleDelete(row)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
