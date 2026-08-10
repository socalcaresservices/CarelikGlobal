import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { uploadOrganizationLogo } from "@/lib/organization-branding";

// Closes a gap the Add Organization wizard's own comment already flagged
// ("Starter branding - a full theme editor is tracked as follow-up
// work."): logo/colors/theme could only ever be set once, at creation,
// by the platform owner - there was no way for an org (or the platform
// owner, after the fact) to edit them again. Same columns, same
// organization.update-gated RLS policy the wizard's insert already
// relies on - this is a normal update through it, not a new permission
// or a parallel branding system.
export function OrganizationBrandingCard({
  organizationId,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const { activeOrganization } = useOrganization();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("");
  const [secondaryColor, setSecondaryColor] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const [showPoweredBy, setShowPoweredBy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form to the organization's current saved values whenever
  // it changes (switching orgs, or this org's row refetching after a
  // save elsewhere) - not just once on mount.
  useEffect(() => {
    setPrimaryColor(activeOrganization?.primaryColor ?? "");
    setSecondaryColor(activeOrganization?.secondaryColor ?? "");
    setAccentColor(activeOrganization?.accentColor ?? "");
    setThemeMode((activeOrganization?.themeMode as "light" | "dark" | undefined) ?? "light");
    setShowPoweredBy(activeOrganization?.showPoweredBy ?? true);
    setLogoPreviewUrl(activeOrganization?.logoUrl ?? null);
    setLogoFile(null);
  }, [activeOrganization]);

  function handleLogoFileChange(file: File | null) {
    setLogoFile(file);
    setError(null);
    setLogoPreviewUrl(file ? URL.createObjectURL(file) : activeOrganization?.logoUrl ?? null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;

    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      let logoUrl = activeOrganization?.logoUrl ?? null;
      if (logoFile) {
        logoUrl = await uploadOrganizationLogo(organizationId, logoFile);
      }

      const { error: updateError } = await supabase
        .from("organizations")
        .update({
          logo_url: logoUrl,
          primary_color: primaryColor.trim() || null,
          secondary_color: secondaryColor.trim() || null,
          accent_color: accentColor.trim() || null,
          theme_mode: themeMode,
          show_powered_by: showPoweredBy
        })
        .eq("id", organizationId);
      if (updateError) throw updateError;

      setLogoFile(null);
      setSaved(true);
      // The sidebar/header read colors from the same "organizations"
      // query (organization-provider.tsx) - invalidate it so branding
      // updates without a full page reload.
      void queryClient.invalidateQueries({ queryKey: ["organizations", user?.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save branding.");
    } finally {
      setSaving(false);
    }
  }

  if (!canRead) return null;

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Branding</h3>
      <p className="mt-1 text-xs text-slate-500">
        Your logo, brand colors, and theme - shown across your workspace and on public pages like the applicant and
        upload forms.
      </p>
      {canManage ? (
        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label htmlFor="branding-logo-file" className="block text-xs font-medium text-slate-600">
              Logo
            </label>
            <div className="mt-1 flex items-center gap-4">
              {logoPreviewUrl ? (
                <img
                  src={logoPreviewUrl}
                  alt="Logo preview"
                  className="h-16 w-16 rounded-lg border border-slate-200 object-contain"
                />
              ) : null}
              <div className="flex-1">
                <input
                  id="branding-logo-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => handleLogoFileChange(event.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                />
                <p className="mt-1 text-xs text-slate-500">PNG, JPEG, or WebP - up to 5MB.</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="branding-primary" className="block text-xs font-medium text-slate-600">
                Primary color
              </label>
              <div className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-8 w-8 shrink-0 rounded-lg border border-slate-200"
                  style={{ backgroundColor: primaryColor || "#ffffff" }}
                />
                <input
                  id="branding-primary"
                  value={primaryColor}
                  onChange={(event) => setPrimaryColor(event.target.value)}
                  placeholder="#0f172a"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label htmlFor="branding-secondary" className="block text-xs font-medium text-slate-600">
                Secondary color
              </label>
              <div className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-8 w-8 shrink-0 rounded-lg border border-slate-200"
                  style={{ backgroundColor: secondaryColor || "#ffffff" }}
                />
                <input
                  id="branding-secondary"
                  value={secondaryColor}
                  onChange={(event) => setSecondaryColor(event.target.value)}
                  placeholder="#64748b"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label htmlFor="branding-accent" className="block text-xs font-medium text-slate-600">
                Accent color
              </label>
              <div className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-8 w-8 shrink-0 rounded-lg border border-slate-200"
                  style={{ backgroundColor: accentColor || "#ffffff" }}
                />
                <input
                  id="branding-accent"
                  value={accentColor}
                  onChange={(event) => setAccentColor(event.target.value)}
                  placeholder="#0ea5e9"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <label htmlFor="branding-theme" className="block text-xs font-medium text-slate-600">
                Theme
              </label>
              <select
                id="branding-theme"
                value={themeMode}
                onChange={(event) => setThemeMode(event.target.value as "light" | "dark")}
                className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={showPoweredBy}
                onChange={(event) => setShowPoweredBy(event.target.checked)}
                className="h-4 w-4"
              />
              Show &quot;Powered by Ogevia&quot; on public pages
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" loading={saving}>
              {saving ? "Saving…" : "Save branding"}
            </Button>
            {saved ? <span className="text-sm text-emerald-700">Saved</span> : null}
          </div>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </form>
      ) : (
        <p className="mt-3 text-sm text-slate-400">You don&apos;t have permission to edit branding for this organization.</p>
      )}
    </Card>
  );
}
