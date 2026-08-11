import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, Button, StatusBadge, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAuth } from "@carelik/auth";
import { supabase } from "@/lib/supabase";
import { BillingSummaryCard } from "@/components/billing-summary-card";
import { OrganizationBrandingCard } from "@/components/organization-branding-card";

// Skills and languages are org-scoped lookup catalogs (same shape as the
// service catalog, Build 003) that feed the picker on caregiver and
// client profiles - see 20260727070000_skills_and_languages_catalog.sql
// for why these exist as real tables instead of staying free text.
// "Delete" here means deactivate (is_active = false), not a hard
// delete: a caregiver or client may already have the name recorded on
// their profile, and hard-deleting the catalog row would silently break
// showing that history without actually removing the reference.
interface LookupRow {
  id: string;
  name: string;
  is_active: boolean;
}

function LookupCatalogCard({
  table,
  title,
  hint,
  organizationId,
  canRead,
  canUpdate
}: {
  table: "skills" | "languages";
  title: string;
  hint: string;
  organizationId: string | null | undefined;
  canRead: boolean;
  canUpdate: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: [table, organizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from(table)
        .select("id, name, is_active")
        .eq("organization_id", organizationId!)
        .is("deleted_at", null)
        .order("name");
      if (queryError) throw queryError;
      return (data ?? []) as LookupRow[];
    },
    enabled: !!organizationId && canRead
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: [table, organizationId] });
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !name.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const { error: insertError } = await supabase
        .from(table)
        .insert({ organization_id: organizationId, name: name.trim() });
      if (insertError) throw insertError;
      setName("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not add ${title.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row: LookupRow) {
    setError(null);
    setPendingId(row.id);
    try {
      const { error: updateError } = await supabase
        .from(table)
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (updateError) throw updateError;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not update ${title.toLowerCase()}.`);
    } finally {
      setPendingId(null);
    }
  }

  if (!canRead) return null;

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>

      {canUpdate ? (
        <form onSubmit={handleAdd} className="mt-4 flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor={`${table}-new-name`} className="block text-xs font-medium text-slate-600">
              Add {title.toLowerCase().replace(/s$/, "")}
            </label>
            <input
              id={`${table}-new-name`}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <Button type="submit" size="sm" loading={saving}>
            Add
          </Button>
        </form>
      ) : null}

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

      {listQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : listQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load {title.toLowerCase()}.</p>
      ) : (listQuery.data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">None configured yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {(listQuery.data ?? []).map((row) => (
            <li key={row.id} className="flex items-center justify-between py-2">
              <span className={row.is_active ? "text-sm text-slate-800" : "text-sm text-slate-400 line-through"}>
                {row.name}
              </span>
              {canUpdate ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={pendingId === row.id}
                  onClick={() => toggleActive(row)}
                >
                  {row.is_active ? "Deactivate" : "Reactivate"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Document type library (Build 019) - unlike skills/languages, this
// catalog has two kinds of rows: platform defaults (organization_id is
// null, seeded once for every organization to use immediately - see
// 20260728030000) and an organization's own custom additions
// (organization_id set). Defaults are shown read-only here; only an
// organization's own rows can be deactivated, since has_permission(null,
// ...) - and therefore the RLS write policy - never lets a regular
// admin touch them anyway.
interface DocumentTypeRow {
  id: string;
  organization_id: string | null;
  name: string;
  category: string | null;
  requires_expiration: boolean;
  is_active: boolean;
}

function DocumentTypesCard({
  organizationId,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [requiresExpiration, setRequiresExpiration] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["document-types", organizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("document_types")
        .select("id, organization_id, name, category, requires_expiration, is_active")
        .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
        .is("deleted_at", null)
        .order("name");
      if (queryError) throw queryError;
      return (data ?? []) as DocumentTypeRow[];
    },
    enabled: !!organizationId && canRead
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["document-types", organizationId] });
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !name.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const { error: insertError } = await supabase.from("document_types").insert({
        organization_id: organizationId,
        name: name.trim(),
        category: category.trim() || null,
        requires_expiration: requiresExpiration
      });
      if (insertError) throw insertError;
      setName("");
      setCategory("");
      setRequiresExpiration(false);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add document type.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row: DocumentTypeRow) {
    setError(null);
    setPendingId(row.id);
    try {
      const { error: updateError } = await supabase
        .from("document_types")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (updateError) throw updateError;
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update document type.");
    } finally {
      setPendingId(null);
    }
  }

  if (!canRead) return null;

  const rows = listQuery.data ?? [];

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Document types</h3>
      <p className="mt-1 text-xs text-slate-500">
        The documents that can be requested from applicants and employees - platform defaults are available to
        every organization; add your own below.
      </p>

      {canManage ? (
        <form onSubmit={handleAdd} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label htmlFor="document-type-new-name" className="block text-xs font-medium text-slate-600">
              Add document type
            </label>
            <input
              id="document-type-new-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label htmlFor="document-type-new-category" className="block text-xs font-medium text-slate-600">
              Category
            </label>
            <input
              id="document-type-new-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="mt-1 w-40 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <label htmlFor="document-type-new-expires" className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input
              id="document-type-new-expires"
              type="checkbox"
              checked={requiresExpiration}
              onChange={(event) => setRequiresExpiration(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Expires
          </label>
          <Button type="submit" size="sm" loading={saving}>
            Add
          </Button>
        </form>
      ) : null}

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

      {listQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : listQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load document types.</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">None configured yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between py-2">
              <span className={row.is_active ? "text-sm text-slate-800" : "text-sm text-slate-400 line-through"}>
                {row.name}
                {row.category ? <span className="ml-2 text-xs text-slate-400">{row.category}</span> : null}
                {row.organization_id === null ? (
                  <span className="ml-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                    Platform default
                  </span>
                ) : null}
              </span>
              {canManage && row.organization_id !== null ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={pendingId === row.id}
                  onClick={() => toggleActive(row)}
                >
                  {row.is_active ? "Deactivate" : "Reactivate"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Reminder cadence for outstanding document requests (Build 022) - reads
// through get_document_reminder_settings() rather than the table
// directly, since that RPC already applies the "enabled, every 3 days,
// up to 3 reminders" defaults for an organization that's never touched
// this setting, so the form doesn't have to duplicate them.
interface ReminderSettings {
  enabled: boolean;
  interval_days: number;
  max_reminders: number;
}

function ReminderSettingsCard({
  organizationId,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReminderSettings | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["document-reminder-settings", organizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("get_document_reminder_settings", {
        target_organization_id: organizationId!
      });
      if (queryError) throw queryError;
      return ((data ?? [])[0] ?? null) as ReminderSettings | null;
    },
    enabled: !!organizationId && canRead
  });

  const current = draft ?? settingsQuery.data;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !current) return;
    setError(null);
    setSaving(true);
    try {
      const { error: saveError } = await supabase.rpc("set_document_reminder_settings", {
        target_organization_id: organizationId,
        target_enabled: current.enabled,
        target_interval_days: current.interval_days,
        target_max_reminders: current.max_reminders
      });
      if (saveError) throw saveError;
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["document-reminder-settings", organizationId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save reminder settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!canRead) return null;

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Document request reminders</h3>
      <p className="mt-1 text-xs text-slate-500">
        How often to nudge an applicant or employee about a document request they haven&apos;t finished yet.
      </p>

      {settingsQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : settingsQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load reminder settings.</p>
      ) : !current ? (
        <p className="mt-3 text-sm text-slate-400">No reminder settings configured yet.</p>
      ) : (
        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              disabled={!canManage}
              checked={current.enabled}
              onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Send reminders
          </label>
          <div className="flex flex-wrap gap-4">
            <div>
              <label htmlFor="reminder-interval-days" className="block text-xs font-medium text-slate-600">
                Every (days)
              </label>
              <input
                id="reminder-interval-days"
                type="number"
                min={1}
                max={90}
                disabled={!canManage}
                value={current.interval_days}
                onChange={(event) => setDraft({ ...current, interval_days: Number(event.target.value) })}
                className="mt-1 w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="reminder-max-count" className="block text-xs font-medium text-slate-600">
                Up to
              </label>
              <input
                id="reminder-max-count"
                type="number"
                min={0}
                max={20}
                disabled={!canManage}
                value={current.max_reminders}
                onChange={(event) => setDraft({ ...current, max_reminders: Number(event.target.value) })}
                className="mt-1 w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>
          {canManage ? (
            <Button type="submit" size="sm" loading={saving}>
              Save
            </Button>
          ) : null}
        </form>
      )}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Card>
  );
}

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

// Mirrors public.support_access_status (supabase/migrations/20260807000000_support_access.sql).
type SupportAccessStatus = "requested" | "active" | "expired" | "revoked" | "denied";

interface SupportAccessGrant {
  id: string;
  organization_id: string;
  grantee_user_id: string;
  requested_by: string;
  reason: string;
  status: SupportAccessStatus;
  requested_minutes: number;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

const SUPPORT_ACCESS_STATUS: Record<SupportAccessStatus, { label: string; tone: StatusTone }> = {
  requested: { label: "Requested", tone: "info" },
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
  denied: { label: "Denied", tone: "danger" }
};

// A grant's `status` column never flips to 'expired' on its own - it
// stays 'active' after expires_at passes until someone revokes it (see
// has_active_support_access(), which checks both together). Derives the
// display-only distinction so a lapsed grant doesn't keep reading "Active"
// with an Approve/Deny/Revoke row that no longer means anything.
function isEffectivelyExpired(grant: SupportAccessGrant) {
  return grant.status === "active" && grant.expires_at !== null && new Date(grant.expires_at) <= new Date();
}

// Approve/deny/revoke for Ogevia staff requesting time-boxed access into
// this organization (see organizations-page.tsx's SupportAccessPanel for
// the platform-side request UI). Gated on settings.update, same
// permission approve_support_access/deny_support_access/
// revoke_support_access check server-side - canManage here is purely
// about which buttons render, the RPCs re-check permission themselves.
function SupportAccessCard({
  organizationId,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const grantsQuery = useQuery({
    queryKey: ["support-access-grants", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_support_access_grants", {
        target_organization_id: organizationId!
      });
      if (error) throw error;
      return (data ?? []) as SupportAccessGrant[];
    },
    enabled: !!organizationId && canRead
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["support-access-grants", organizationId] });
  }

  async function runAction(grantId: string, rpc: "approve_support_access" | "deny_support_access" | "revoke_support_access", failureMessage: string) {
    setActionError(null);
    setPendingId(grantId);
    try {
      const { error } = await supabase.rpc(rpc, { grant_id: grantId });
      if (error) throw error;
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : failureMessage);
    } finally {
      setPendingId(null);
    }
  }

  if (!canRead) return null;

  const grants = grantsQuery.data ?? [];

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Support access</h3>
      <p className="mt-1 text-xs text-slate-500">
        When Ogevia staff need to look into an issue for your account, they request time-boxed access here -
        nothing is granted until you approve it, and you can revoke it early at any time.
      </p>
      {actionError ? <p className="mt-2 text-sm text-red-700">{actionError}</p> : null}
      {grantsQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : grantsQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load support access requests.</p>
      ) : grants.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">No support access has been requested.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {grants.map((grant) => {
            const expired = isEffectivelyExpired(grant);
            const display = expired ? { label: "Expired", tone: "neutral" as const } : SUPPORT_ACCESS_STATUS[grant.status];
            return (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm text-slate-800">{grant.reason}</p>
                  <p className="text-xs text-slate-500">
                    Requested {new Date(grant.created_at).toLocaleString()}
                    {grant.expires_at
                      ? ` · ${expired ? "expired" : "expires"} ${new Date(grant.expires_at).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge label={display.label} tone={display.tone} />
                  {canManage && grant.status === "requested" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        loading={pendingId === grant.id}
                        onClick={() => runAction(grant.id, "approve_support_access", "Could not approve this request.")}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        loading={pendingId === grant.id}
                        onClick={() => runAction(grant.id, "deny_support_access", "Could not deny this request.")}
                      >
                        Deny
                      </Button>
                    </>
                  ) : null}
                  {canManage && grant.status === "active" && !expired ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={pendingId === grant.id}
                      onClick={() => runAction(grant.id, "revoke_support_access", "Could not revoke this access.")}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// Self-serve custom domain (Build 022 item 4) - a single organization
// column (organizations.custom_domain), so this reads/writes it
// directly rather than through organization_settings' generic
// key/value store. Gated on organization.read/organization.update, the
// same permission pair the old platform-only org-profile editor used
// (see organizations-page.tsx's history) - every role can see the
// domain, only owner/admin can change it.
function CustomDomainCard({
  organizationId,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const domainQuery = useQuery({
    queryKey: ["organization-custom-domain", organizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("organizations")
        .select("custom_domain")
        .eq("id", organizationId!)
        .single();
      if (queryError) throw queryError;
      return (data?.custom_domain as string | null) ?? "";
    },
    enabled: !!organizationId && canRead
  });

  useEffect(() => {
    if (domainQuery.data === undefined) return;
    setDomain(domainQuery.data);
    setError(null);
    setSuccess(false);
  }, [domainQuery.data]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      const trimmed = domain.trim().toLowerCase();
      const { error: saveError } = await supabase
        .from("organizations")
        .update({ custom_domain: trimmed || null })
        .eq("id", organizationId);
      if (saveError) throw saveError;
      setSuccess(true);
      void queryClient.invalidateQueries({ queryKey: ["organization-custom-domain", organizationId] });
    } catch (cause) {
      const pgError = cause as { code?: string; message?: string };
      if (pgError.code === "23505") {
        setError("That domain is already in use by another organization.");
      } else if (pgError.code === "23514") {
        setError("Enter a valid domain (e.g. app.youragency.com).");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not save this domain.");
      }
    } finally {
      setSaving(false);
    }
  }

  if (!canRead) return null;

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Custom domain</h3>
      <p className="mt-1 text-xs text-slate-500">
        Use your own domain instead of an ogevia.com subdomain. After saving it here, point the domain's DNS at
        Ogevia and let us know so it can be added to hosting and issued a certificate - it won't work until both
        steps are done.
      </p>
      {domainQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : domainQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load the current domain.</p>
      ) : (
        <form onSubmit={handleSave} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="custom-domain" className="block text-xs font-medium text-slate-600">
              Domain
            </label>
            <input
              id="custom-domain"
              disabled={!canManage}
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="app.youragency.com"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>
          {canManage ? (
            <Button type="submit" size="sm" loading={saving}>
              Save
            </Button>
          ) : null}
        </form>
      )}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      {success ? <p className="mt-2 text-sm text-emerald-700">Saved.</p> : null}
    </Card>
  );
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

      <OrganizationBrandingCard
        organizationId={activeOrganizationId}
        canRead={hasPermission("organization.read")}
        canManage={hasPermission("organization.update")}
      />

      <BillingSummaryCard organizationId={activeOrganizationId} canRead={canRead} canUpdate={canUpdate} />

      <SupportAccessCard organizationId={activeOrganizationId} canRead={canRead} canManage={canUpdate} />

      <CustomDomainCard
        organizationId={activeOrganizationId}
        canRead={hasPermission("organization.read")}
        canManage={hasPermission("organization.update")}
      />

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
              <Button type="submit" loading={saving}>
                {saving ? "Saving…" : editingVersion !== null ? "Save changes" : "Add setting"}
              </Button>
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

      <LookupCatalogCard
        table="skills"
        title="Skills"
        hint="The skills caregivers can pick on their profile and clients can pick as care needs - powers CareScore matching, so a shared list here means fewer missed matches from typos."
        organizationId={activeOrganizationId}
        canRead={hasPermission("skills.read")}
        canUpdate={hasPermission("skills.update")}
      />

      <LookupCatalogCard
        table="languages"
        title="Languages"
        hint="The languages caregivers can pick on their profile and clients can pick as language needs - also powers CareScore matching."
        organizationId={activeOrganizationId}
        canRead={hasPermission("languages.read")}
        canUpdate={hasPermission("languages.update")}
      />

      <DocumentTypesCard
        organizationId={activeOrganizationId}
        canRead={hasPermission("documents.read")}
        canManage={hasPermission("documents.manage")}
      />

      <ReminderSettingsCard
        organizationId={activeOrganizationId}
        canRead={hasPermission("documents.read")}
        canManage={hasPermission("documents.manage")}
      />
    </section>
  );
}
