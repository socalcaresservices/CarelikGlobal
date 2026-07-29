import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { uploadOrganizationLogo } from "@/lib/organization-branding";
import { usePlatform } from "@/providers/platform-provider";
import { Navigate } from "react-router-dom";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every column the onboarding wizard (Build 013) collects, minus id/slug/
// status/country_code/metadata/created_*/updated_*/deleted_at - slug is
// the org's URL and deliberately not editable here (same reasoning as
// the wizard never letting you type one after Finish); status is a
// platform-level lifecycle field, not a profile edit. Everything else
// the wizard can set on creation should be editable after creation too -
// before this build, only legal_name/display_name/timezone were.
interface OrganizationProfile {
  legal_name: string;
  display_name: string;
  timezone: string;
  dba: string | null;
  tax_id: string | null;
  business_license: string | null;
  org_type: string | null;
  website: string | null;
  currency: string;
  agency_code: string | null;
  address_street: string | null;
  address_suite: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_country: string | null;
  primary_contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  emergency_phone: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  theme_mode: "light" | "dark";
  show_powered_by: boolean;
}

const PROFILE_COLUMNS =
  "legal_name, display_name, timezone, dba, tax_id, business_license, org_type, website, currency, agency_code, " +
  "address_street, address_suite, address_city, address_state, address_zip, address_country, " +
  "primary_contact_name, contact_email, contact_phone, emergency_phone, logo_url, " +
  "primary_color, secondary_color, accent_color, theme_mode, show_powered_by";

function inputClass() {
  return "mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900";
}

function labelClass() {
  return "block text-xs font-medium text-slate-600";
}

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

  // Build 022: Tenant users should not access /organizations (platform-only page)
  // Redirect to /settings if accessed from tenant context
  if (!isPlatformOwner && activeOrganization) {
    return <Navigate to="/settings" replace />;
  }

  function refreshOrganizations() {
    void queryClient.invalidateQueries({ queryKey: ["organizations"] });
    void queryClient.invalidateQueries({ queryKey: ["organization-profile", activeOrganizationId] });
  }

  // --- edit the active organization (gated by organization.update, same
  // permission the RLS "authorized_update_organizations" policy checks) ---
  const canEditActive = !!activeOrganization && hasPermission("organization.update");

  const profileQuery = useQuery({
    queryKey: ["organization-profile", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select(PROFILE_COLUMNS)
        .eq("id", activeOrganizationId!)
        .single();
      if (error) throw error;
      return data as unknown as OrganizationProfile;
    },
    enabled: !!activeOrganizationId && canEditActive
  });

  const [editForm, setEditForm] = useState<OrganizationProfile | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!profileQuery.data) return;
    setEditForm(profileQuery.data);
    setEditError(null);
    setEditSuccess(null);
  }, [profileQuery.data]);

  function update<K extends keyof OrganizationProfile>(key: K, value: OrganizationProfile[K]) {
    setEditForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function handleLogoFileChange(file: File | null) {
    setLogoError(null);
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    if (!file) {
      setLogoFile(null);
      setLogoPreviewUrl(null);
      return;
    }
    // Keep in sync with organization-branding.ts's ALLOWED_LOGO_TYPES -
    // SVG is deliberately excluded (20260729030000), see that file's
    // comment.
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (!allowed.includes(file.type)) {
      setLogoError("Logo must be a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Logo must be 5MB or smaller.");
      return;
    }
    setLogoFile(file);
    setLogoPreviewUrl(URL.createObjectURL(file));
  }

  async function handleSaveEdit() {
    if (!activeOrganization || !editForm) return;
    if (editForm.contact_email && !EMAIL_PATTERN.test(editForm.contact_email)) {
      setEditError("Enter a valid contact email.");
      return;
    }

    setSavingEdit(true);
    setEditError(null);
    setEditSuccess(null);
    try {
      let logoUrl = editForm.logo_url;
      if (logoFile) {
        logoUrl = await uploadOrganizationLogo(activeOrganization.id, logoFile);
      }

      // Empty optional fields are saved as null rather than "" - same
      // convention the onboarding wizard uses (add-organization-page.tsx's
      // handleFinalSubmit), so a field someone clears out doesn't linger
      // as a blank string that then trips up things like agency_code's
      // partial unique index in a confusing way.
      const nullIfBlank = (value: string | null) => {
        const trimmed = value?.trim();
        return trimmed ? trimmed : null;
      };

      const { error } = await supabase
        .from("organizations")
        .update({
          legal_name: editForm.legal_name.trim(),
          display_name: editForm.display_name.trim(),
          timezone: editForm.timezone.trim(),
          currency: editForm.currency.trim(),
          theme_mode: editForm.theme_mode,
          dba: nullIfBlank(editForm.dba),
          tax_id: nullIfBlank(editForm.tax_id),
          business_license: nullIfBlank(editForm.business_license),
          org_type: nullIfBlank(editForm.org_type),
          website: nullIfBlank(editForm.website),
          agency_code: nullIfBlank(editForm.agency_code),
          address_street: nullIfBlank(editForm.address_street),
          address_suite: nullIfBlank(editForm.address_suite),
          address_city: nullIfBlank(editForm.address_city),
          address_state: nullIfBlank(editForm.address_state),
          address_zip: nullIfBlank(editForm.address_zip),
          address_country: nullIfBlank(editForm.address_country),
          primary_contact_name: nullIfBlank(editForm.primary_contact_name),
          contact_email: nullIfBlank(editForm.contact_email),
          contact_phone: nullIfBlank(editForm.contact_phone),
          emergency_phone: nullIfBlank(editForm.emergency_phone),
          logo_url: nullIfBlank(logoUrl),
          primary_color: nullIfBlank(editForm.primary_color),
          secondary_color: nullIfBlank(editForm.secondary_color),
          accent_color: nullIfBlank(editForm.accent_color),
          show_powered_by: editForm.show_powered_by
        })
        .eq("id", activeOrganization.id);
      if (error) throw error;

      setEditSuccess("Saved.");
      handleLogoFileChange(null);
      refreshOrganizations();
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Could not save changes.");
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">Organizations</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            {organizations.length} organization{organizations.length === 1 ? "" : "s"}
          </h2>
        </div>
        {isPlatformOwner ? (
          <Link to="/organizations/new" className={buttonVariants()}>
            + New Organization
          </Link>
        ) : null}
      </div>

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
          <h3 className="font-semibold text-slate-950">Edit {activeOrganization?.displayName}</h3>
          {profileQuery.isLoading || !editForm ? (
            <p className="mt-3 text-sm text-slate-500">Loading organization details…</p>
          ) : profileQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load organization details.</p>
          ) : (
            <div className="mt-4 space-y-6">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Organization</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="edit-org-legal-name" className={labelClass()}>
                      Legal name
                    </label>
                    <input
                      id="edit-org-legal-name"
                      required
                      value={editForm.legal_name}
                      onChange={(event) => update("legal_name", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-display-name" className={labelClass()}>
                      Display name
                    </label>
                    <input
                      id="edit-org-display-name"
                      required
                      value={editForm.display_name}
                      onChange={(event) => update("display_name", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-dba" className={labelClass()}>
                      DBA
                    </label>
                    <input
                      id="edit-org-dba"
                      value={editForm.dba ?? ""}
                      onChange={(event) => update("dba", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-tax-id" className={labelClass()}>
                      Tax ID
                    </label>
                    <input
                      id="edit-org-tax-id"
                      value={editForm.tax_id ?? ""}
                      onChange={(event) => update("tax_id", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-business-license" className={labelClass()}>
                      Business license
                    </label>
                    <input
                      id="edit-org-business-license"
                      value={editForm.business_license ?? ""}
                      onChange={(event) => update("business_license", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-type" className={labelClass()}>
                      Organization type
                    </label>
                    <input
                      id="edit-org-type"
                      value={editForm.org_type ?? ""}
                      onChange={(event) => update("org_type", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-website" className={labelClass()}>
                      Website
                    </label>
                    <input
                      id="edit-org-website"
                      value={editForm.website ?? ""}
                      onChange={(event) => update("website", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-timezone" className={labelClass()}>
                      Timezone
                    </label>
                    <input
                      id="edit-org-timezone"
                      required
                      value={editForm.timezone}
                      onChange={(event) => update("timezone", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-currency" className={labelClass()}>
                      Currency
                    </label>
                    <input
                      id="edit-org-currency"
                      required
                      value={editForm.currency}
                      onChange={(event) => update("currency", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-agency-code" className={labelClass()}>
                      Agency code
                    </label>
                    <input
                      id="edit-org-agency-code"
                      value={editForm.agency_code ?? ""}
                      onChange={(event) => update("agency_code", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Address</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label htmlFor="edit-org-street" className={labelClass()}>
                      Street
                    </label>
                    <input
                      id="edit-org-street"
                      value={editForm.address_street ?? ""}
                      onChange={(event) => update("address_street", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-suite" className={labelClass()}>
                      Suite
                    </label>
                    <input
                      id="edit-org-suite"
                      value={editForm.address_suite ?? ""}
                      onChange={(event) => update("address_suite", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-city" className={labelClass()}>
                      City
                    </label>
                    <input
                      id="edit-org-city"
                      value={editForm.address_city ?? ""}
                      onChange={(event) => update("address_city", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-state" className={labelClass()}>
                      State
                    </label>
                    <input
                      id="edit-org-state"
                      value={editForm.address_state ?? ""}
                      onChange={(event) => update("address_state", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-zip" className={labelClass()}>
                      ZIP
                    </label>
                    <input
                      id="edit-org-zip"
                      value={editForm.address_zip ?? ""}
                      onChange={(event) => update("address_zip", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-country" className={labelClass()}>
                      Country
                    </label>
                    <input
                      id="edit-org-country"
                      value={editForm.address_country ?? ""}
                      onChange={(event) => update("address_country", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label htmlFor="edit-org-contact-name" className={labelClass()}>
                      Primary contact
                    </label>
                    <input
                      id="edit-org-contact-name"
                      value={editForm.primary_contact_name ?? ""}
                      onChange={(event) => update("primary_contact_name", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-contact-email" className={labelClass()}>
                      Email
                    </label>
                    <input
                      id="edit-org-contact-email"
                      type="email"
                      value={editForm.contact_email ?? ""}
                      onChange={(event) => update("contact_email", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-contact-phone" className={labelClass()}>
                      Phone
                    </label>
                    <input
                      id="edit-org-contact-phone"
                      value={editForm.contact_phone ?? ""}
                      onChange={(event) => update("contact_phone", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-emergency-phone" className={labelClass()}>
                      Emergency phone
                    </label>
                    <input
                      id="edit-org-emergency-phone"
                      value={editForm.emergency_phone ?? ""}
                      onChange={(event) => update("emergency_phone", event.target.value)}
                      className={inputClass()}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Branding</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-3">
                    <label htmlFor="edit-org-logo-file" className={labelClass()}>
                      Logo
                    </label>
                    <div className="mt-1 flex items-center gap-4">
                      {logoPreviewUrl ?? editForm.logo_url ? (
                        <img
                          src={logoPreviewUrl ?? editForm.logo_url ?? undefined}
                          alt="Logo preview"
                          className="h-16 w-16 rounded-lg border border-slate-200 object-contain"
                        />
                      ) : null}
                      <div className="flex-1">
                        <input
                          id="edit-org-logo-file"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(event) => handleLogoFileChange(event.target.files?.[0] ?? null)}
                          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                        />
                        <p className="mt-1 text-xs text-slate-500">PNG, JPEG, or WebP - up to 5MB.</p>
                      </div>
                    </div>
                    {logoError ? <p className="mt-1 text-sm text-red-700">{logoError}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="edit-org-primary-color" className={labelClass()}>
                      Primary color
                    </label>
                    <input
                      id="edit-org-primary-color"
                      value={editForm.primary_color ?? ""}
                      onChange={(event) => update("primary_color", event.target.value)}
                      placeholder="#0f172a"
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-secondary-color" className={labelClass()}>
                      Secondary color
                    </label>
                    <input
                      id="edit-org-secondary-color"
                      value={editForm.secondary_color ?? ""}
                      onChange={(event) => update("secondary_color", event.target.value)}
                      placeholder="#64748b"
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-accent-color" className={labelClass()}>
                      Accent color
                    </label>
                    <input
                      id="edit-org-accent-color"
                      value={editForm.accent_color ?? ""}
                      onChange={(event) => update("accent_color", event.target.value)}
                      placeholder="#0ea5e9"
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label htmlFor="edit-org-theme-mode" className={labelClass()}>
                      Theme
                    </label>
                    <select
                      id="edit-org-theme-mode"
                      value={editForm.theme_mode}
                      onChange={(event) => update("theme_mode", event.target.value as "light" | "dark")}
                      className={inputClass()}
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </div>
                  <div className="flex items-end pb-2">
                    <label htmlFor="edit-org-powered-by" className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        id="edit-org-powered-by"
                        type="checkbox"
                        checked={editForm.show_powered_by}
                        onChange={(event) => update("show_powered_by", event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Show "Powered by CareLik"
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <Button onClick={handleSaveEdit} loading={savingEdit}>
                  {savingEdit ? "Saving…" : "Save changes"}
                </Button>
              </div>
              {editError ? <p className="text-sm text-red-700">{editError}</p> : null}
              {editSuccess ? <p className="text-sm text-emerald-700">{editSuccess}</p> : null}
            </div>
          )}
        </Card>
      ) : null}
    </section>
  );
}
