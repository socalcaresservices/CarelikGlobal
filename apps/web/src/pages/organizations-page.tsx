import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function OrganizationsPage() {
  const {
    organizations,
    activeOrganization,
    activeOrganizationId,
    setActiveOrganizationId,
    isPlatformOwner,
    hasPermission
  } = useOrganization();
  const queryClient = useQueryClient();

  function refreshOrganizations() {
    void queryClient.invalidateQueries({ queryKey: ["organizations"] });
  }

  // --- create organization (platform owner only; no INSERT RLS policy
  // exists on purpose, so this goes through create_organization()) ---
  const [slug, setSlug] = useState("");
  const [newLegalName, setNewLegalName] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);

    if (!SLUG_PATTERN.test(slug)) {
      setCreateError("Slug must be lowercase letters, numbers, and hyphens (2-63 characters).");
      return;
    }

    setCreating(true);
    try {
      const { error } = await supabase.rpc("create_organization", {
        slug,
        legal_name: newLegalName,
        display_name: newDisplayName
      });
      if (error) throw error;
      setSlug("");
      setNewLegalName("");
      setNewDisplayName("");
      refreshOrganizations();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create organization.");
    } finally {
      setCreating(false);
    }
  }

  // --- edit the active organization (gated by organization.update, same
  // permission the RLS "authorized_update_organizations" policy checks) ---
  const canEditActive = !!activeOrganization && hasPermission("organization.update");
  const [editLegalName, setEditLegalName] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editTimezone, setEditTimezone] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrganization) return;
    setEditLegalName(activeOrganization.legalName);
    setEditDisplayName(activeOrganization.displayName);
    setEditTimezone(activeOrganization.timezone);
    setEditError(null);
    setEditSuccess(null);
  }, [activeOrganization]);

  async function handleSaveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganization) return;

    setSavingEdit(true);
    setEditError(null);
    setEditSuccess(null);
    try {
      const { error } = await supabase
        .from("organizations")
        .update({
          legal_name: editLegalName,
          display_name: editDisplayName,
          timezone: editTimezone
        })
        .eq("id", activeOrganization.id);
      if (error) throw error;
      setEditSuccess("Saved.");
      refreshOrganizations();
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Could not save changes.");
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Organizations</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {organizations.length} organization{organizations.length === 1 ? "" : "s"}
        </h2>
      </div>

      {isPlatformOwner ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Create organization</h3>
          <form onSubmit={handleCreate} className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="new-org-slug" className="block text-xs font-medium text-slate-600">
                Slug
              </label>
              <input
                id="new-org-slug"
                required
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="acme-care"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="new-org-legal-name" className="block text-xs font-medium text-slate-600">
                Legal name
              </label>
              <input
                id="new-org-legal-name"
                required
                value={newLegalName}
                onChange={(event) => setNewLegalName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="new-org-display-name" className="block text-xs font-medium text-slate-600">
                Display name
              </label>
              <input
                id="new-org-display-name"
                required
                value={newDisplayName}
                onChange={(event) => setNewDisplayName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {creating ? "Creating…" : "Create organization"}
              </button>
            </div>
          </form>
          {createError ? <p className="mt-3 text-sm text-red-700">{createError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <h3 className="font-semibold text-slate-950">All organizations</h3>
        {organizations.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No organizations yet.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Slug</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 text-slate-800">{org.displayName}</td>
                  <td className="py-2.5 text-slate-500">{org.slug}</td>
                  <td className="py-2.5 text-slate-600">{org.status}</td>
                  <td className="py-2.5 text-right">
                    {org.id === activeOrganizationId ? (
                      <span className="text-xs font-medium text-slate-400">Active</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setActiveOrganizationId(org.id)}
                        className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                      >
                        Switch
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {canEditActive ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            Edit {activeOrganization?.displayName}
          </h3>
          <form onSubmit={handleSaveEdit} className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="edit-org-legal-name" className="block text-xs font-medium text-slate-600">
                Legal name
              </label>
              <input
                id="edit-org-legal-name"
                required
                value={editLegalName}
                onChange={(event) => setEditLegalName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="edit-org-display-name" className="block text-xs font-medium text-slate-600">
                Display name
              </label>
              <input
                id="edit-org-display-name"
                required
                value={editDisplayName}
                onChange={(event) => setEditDisplayName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="edit-org-timezone" className="block text-xs font-medium text-slate-600">
                Timezone
              </label>
              <input
                id="edit-org-timezone"
                required
                value={editTimezone}
                onChange={(event) => setEditTimezone(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={savingEdit}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingEdit ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
          {editError ? <p className="mt-3 text-sm text-red-700">{editError}</p> : null}
          {editSuccess ? <p className="mt-3 text-sm text-emerald-700">{editSuccess}</p> : null}
        </Card>
      ) : null}
    </section>
  );
}
