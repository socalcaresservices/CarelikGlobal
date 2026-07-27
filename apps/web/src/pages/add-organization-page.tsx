import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { systemRoleSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember, type InvitableRole } from "@/lib/invitations";
import { uploadOrganizationLogo } from "@/lib/organization-branding";

// Platform-owner-only tenant onboarding wizard. create_organization() -
// extended in place (20260727080000_organization_onboarding.sql), not
// replaced - already handles org creation, giving the caller an
// organization_owner membership, and seeding the org's starter service
// catalog, all in one transaction. This page's job is purely collecting
// the fields that RPC accepts across a guided multi-step form instead of
// one long one, same pattern as apply-page.tsx's applicant wizard.
//
// The "Administrator" step invites one or more *separate* people into
// the new org (via the existing invite-member edge function, reused as-is
// - same call access-page.tsx's Invite form already makes, and the same
// dynamic invitableRoles list access-page.tsx derives from
// systemRoleSchema, rather than a hardcoded subset). The platform owner
// running this wizard also becomes an organization_owner automatically
// (that's what create_organization() has always done) - they exist as an
// owner alongside whoever is invited here, which is normal for a
// platform admin who may need support access later, not a bug.
//
// Logo upload: goes to the public 'organization-branding' storage
// bucket (20260727100000_organization_branding_bucket.sql) *after* the
// organization is created, not during the Branding step itself - the
// bucket's RLS policies key off organization.update on the org's id,
// which doesn't exist yet while still filling out the form. The file is
// staged locally (see logoFile/logoPreviewUrl state) and only uploaded
// once handleFinalSubmit has a real organization id to attach it to.
//
// Deliberately not built here (each is its own follow-up, not silently
// dropped): a real custom-domain/subdomain router for the "Organization
// URL" preview shown in Finish (today it's just the existing `slug`
// field, displayed as a preview, with no actual carelik.com/<slug>
// routing behind it yet); "document folders" from the original spec
// (same storage-bucket subsystem the logo now uses, just not wired up
// for documents yet).

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SUGGESTED_SERVICES = [
  "Respite",
  "Personal Assistance",
  "Supported Living",
  "Companion Care",
  "Transportation",
  "ABA",
  "Nursing",
  "Hospice"
];

// Same dynamic role list access-page.tsx's Invite form uses (all
// invitable roles, not a hardcoded subset) - an onboarding platform owner
// should be able to invite a coordinator or caregiver alongside the
// agency's owner, not just owner/admin.
const invitableRoles = systemRoleSchema.options.filter(
  (role): role is InvitableRole => role !== "platform_owner"
);

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

interface AdministratorInvite {
  email: string;
  role: InvitableRole;
}

function emptyAdministratorInvite(): AdministratorInvite {
  return { email: "", role: "organization_owner" };
}

const STEP_IDS = ["organization", "address", "contact", "branding", "services", "administrator", "review"] as const;
type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  organization: "Organization",
  address: "Address",
  contact: "Contact",
  branding: "Branding",
  services: "Services",
  administrator: "Administrator",
  review: "Review"
};

interface WizardForm {
  legalName: string;
  dba: string;
  taxId: string;
  businessLicense: string;
  orgType: string;
  website: string;
  timezone: string;
  currency: string;
  slug: string;
  agencyCode: string;
  addressStreet: string;
  addressSuite: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  addressCountry: string;
  primaryContactName: string;
  contactEmail: string;
  contactPhone: string;
  emergencyPhone: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  themeMode: "light" | "dark";
}

function emptyForm(): WizardForm {
  return {
    legalName: "",
    dba: "",
    taxId: "",
    businessLicense: "",
    orgType: "",
    website: "",
    timezone: "America/Los_Angeles",
    currency: "USD",
    slug: "",
    agencyCode: "",
    addressStreet: "",
    addressSuite: "",
    addressCity: "",
    addressState: "",
    addressZip: "",
    addressCountry: "US",
    primaryContactName: "",
    contactEmail: "",
    contactPhone: "",
    emergencyPhone: "",
    logoUrl: "",
    primaryColor: "",
    secondaryColor: "",
    accentColor: "",
    themeMode: "light"
  };
}

interface CreatedOrganization {
  id: string;
  slug: string;
  display_name: string;
}

function inputClass() {
  return "mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900";
}

function labelClass() {
  return "block text-xs font-medium text-slate-600";
}

export function AddOrganizationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { isPlatformOwner, setActiveOrganizationId } = useOrganization();

  const [stepIndex, setStepIndex] = useState(0);
  const [form, setForm] = useState<WizardForm>(emptyForm);
  const [selectedServices, setSelectedServices] = useState<string[]>(["Respite", "Personal Assistance"]);
  const [customService, setCustomService] = useState("");
  const [administrators, setAdministrators] = useState<AdministratorInvite[]>([emptyAdministratorInvite()]);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdOrganization, setCreatedOrganization] = useState<CreatedOrganization | null>(null);

  function update<K extends keyof WizardForm>(key: K, value: WizardForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateAdministrator(index: number, patch: Partial<AdministratorInvite>) {
    setAdministrators((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addAdministratorRow() {
    setAdministrators((current) => [...current, emptyAdministratorInvite()]);
  }

  function removeAdministratorRow(index: number) {
    setAdministrators((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function handleLogoFileChange(file: File | null) {
    setLogoError(null);
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    if (!file) {
      setLogoFile(null);
      setLogoPreviewUrl(null);
      return;
    }
    const allowed = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!allowed.includes(file.type)) {
      setLogoError("Logo must be a PNG, JPEG, SVG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Logo must be 5MB or smaller.");
      return;
    }
    setLogoFile(file);
    setLogoPreviewUrl(URL.createObjectURL(file));
  }

  function toggleService(name: string) {
    setSelectedServices((current) =>
      current.includes(name) ? current.filter((service) => service !== name) : [...current, name]
    );
  }

  function addCustomService() {
    const trimmed = customService.trim();
    if (!trimmed || selectedServices.some((service) => service.toLowerCase() === trimmed.toLowerCase())) return;
    setSelectedServices((current) => [...current, trimmed]);
    setCustomService("");
  }

  function validateStep(step: StepId): string | null {
    switch (step) {
      case "organization":
        if (!form.legalName.trim()) return "Legal business name is required.";
        if (!SLUG_PATTERN.test(form.slug)) {
          return "Slug must be lowercase letters, numbers, and hyphens (2-63 characters) - this becomes the organization's URL.";
        }
        return null;
      case "contact":
        if (form.contactEmail && !EMAIL_PATTERN.test(form.contactEmail)) return "Enter a valid contact email.";
        return null;
      case "administrator": {
        const filled = administrators.filter((row) => row.email.trim());
        if (filled.length === 0) return "At least one administrator email is required to invite them.";
        const invalid = filled.find((row) => !EMAIL_PATTERN.test(row.email.trim()));
        if (invalid) return `Enter a valid email for "${invalid.email}".`;
        return null;
      }
      default:
        return null;
    }
  }

  function goToStep(step: StepId) {
    setStepError(null);
    setStepIndex(STEP_IDS.indexOf(step));
  }

  function goNext() {
    const error = validateStep(STEP_IDS[stepIndex]!);
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    setStepIndex((index) => Math.min(index + 1, STEP_IDS.length - 1));
  }

  function goPrevious() {
    setStepError(null);
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  async function handleFinalSubmit() {
    for (const step of ["organization", "contact", "administrator"] as const) {
      const error = validateStep(step);
      if (error) {
        goToStep(step);
        setStepError(error);
        return;
      }
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data, error } = await supabase.rpc("create_organization", {
        slug: form.slug,
        legal_name: form.legalName,
        display_name: form.dba.trim() || form.legalName,
        timezone: form.timezone || "America/Los_Angeles",
        country_code: form.addressCountry || "US",
        dba: form.dba.trim() || null,
        tax_id: form.taxId.trim() || null,
        business_license: form.businessLicense.trim() || null,
        org_type: form.orgType.trim() || null,
        website: form.website.trim() || null,
        currency: form.currency || "USD",
        agency_code: form.agencyCode.trim() || null,
        address_street: form.addressStreet.trim() || null,
        address_suite: form.addressSuite.trim() || null,
        address_city: form.addressCity.trim() || null,
        address_state: form.addressState.trim() || null,
        address_zip: form.addressZip.trim() || null,
        address_country: form.addressCountry.trim() || null,
        primary_contact_name: form.primaryContactName.trim() || null,
        contact_email: form.contactEmail.trim() || null,
        contact_phone: form.contactPhone.trim() || null,
        emergency_phone: form.emergencyPhone.trim() || null,
        logo_url: form.logoUrl.trim() || null,
        primary_color: form.primaryColor.trim() || null,
        secondary_color: form.secondaryColor.trim() || null,
        accent_color: form.accentColor.trim() || null,
        theme_mode: form.themeMode,
        default_services: selectedServices
      });
      if (error) throw error;

      const newOrganization = data as CreatedOrganization;
      void queryClient.invalidateQueries({ queryKey: ["organizations", user?.id] });

      const warnings: string[] = [];

      // Logo upload happens here, not in the Branding step, because the
      // bucket's RLS policies key off organization.update on this id -
      // see the comment near the top of this file. A failure here isn't
      // fatal: the organization still exists and the logo can be added
      // later, so it's collected as a warning rather than aborting.
      if (logoFile) {
        try {
          const logoUrl = await uploadOrganizationLogo(newOrganization.id, logoFile);
          const { error: logoUpdateError } = await supabase
            .from("organizations")
            .update({ logo_url: logoUrl })
            .eq("id", newOrganization.id);
          if (logoUpdateError) throw logoUpdateError;
        } catch (logoCause) {
          warnings.push(
            `the logo upload failed: ${logoCause instanceof Error ? logoCause.message : "unknown error"}.`
          );
        }
      }

      // Deliberately omitting firstName/lastName here - passing them
      // switches invite-member's edge function to the "create the user
      // immediately, no email" branch (see apps/web/src/lib/invitations.ts),
      // which is right for adding a caregiver to an existing roster but
      // wrong here: each administrator needs a real invite email so they
      // can set up their own account.
      const invitees = administrators.filter((row) => row.email.trim());
      const inviteResults = await Promise.allSettled(
        invitees.map((row) =>
          inviteMember({ email: row.email.trim(), organizationId: newOrganization.id, role: row.role })
        )
      );
      inviteResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const cause = result.reason;
          warnings.push(
            `inviting ${invitees[index]!.email} failed: ${cause instanceof Error ? cause.message : "unknown error"}.`
          );
        }
      });

      setCreatedOrganization(newOrganization);
      if (warnings.length > 0) {
        setSubmitError(
          `Organization created, but ${warnings.join(" ")} You can retry these from the Access and Settings pages.`
        );
      }
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Could not create the organization.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can create new organizations.</p>
        </Card>
      </section>
    );
  }

  if (createdOrganization) {
    return (
      <section className="mx-auto max-w-2xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">{createdOrganization.display_name} is live</h2>
          <p className="mt-3 text-sm text-slate-600">
            Organization URL (preview - not yet a routable subdomain):{" "}
            <span className="font-mono text-slate-800">carelik.com/{createdOrganization.slug}</span>
          </p>
          {submitError ? <p className="mt-3 text-sm text-red-700">{submitError}</p> : null}
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => {
                setActiveOrganizationId(createdOrganization.id);
                navigate("/organizations");
              }}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Switch to {createdOrganization.display_name}
            </button>
            <Link
              to="/organizations/new"
              onClick={() => {
                setForm(emptyForm());
                setSelectedServices(["Respite", "Personal Assistance"]);
                setAdministrators([emptyAdministratorInvite()]);
                handleLogoFileChange(null);
                setStepIndex(0);
                setCreatedOrganization(null);
                setSubmitError(null);
              }}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Add another organization
            </Link>
          </div>
        </Card>
      </section>
    );
  }

  const currentStep = STEP_IDS[stepIndex]!;
  const currentStepNumber = stepIndex + 1;
  const totalSteps = STEP_IDS.length;
  const progressPct = Math.round((currentStepNumber / totalSteps) * 100);

  return (
    <section className="mx-auto max-w-2xl pb-24">
      <div>
        <p className="text-sm font-medium text-slate-500">Platform Administration · Organizations</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">New organization</h2>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-slate-500">
          <span>
            Step {currentStepNumber} of {totalSteps} · {STEP_LABELS[currentStep]}
          </span>
          <span>{progressPct}%</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="mt-6 space-y-6" role="group" aria-label={STEP_LABELS[currentStep]}>
        {currentStep === "organization" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Organization</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="wiz-legal-name" className={labelClass()}>
                  Legal business name
                </label>
                <input
                  id="wiz-legal-name"
                  value={form.legalName}
                  onChange={(event) => update("legalName", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-dba" className={labelClass()}>
                  DBA (doing business as)
                </label>
                <input id="wiz-dba" value={form.dba} onChange={(event) => update("dba", event.target.value)} className={inputClass()} />
              </div>
              <div>
                <label htmlFor="wiz-slug" className={labelClass()}>
                  Slug (URL)
                </label>
                <input
                  id="wiz-slug"
                  value={form.slug}
                  onChange={(event) => update("slug", event.target.value)}
                  placeholder="socal"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-agency-code" className={labelClass()}>
                  Agency code
                </label>
                <input
                  id="wiz-agency-code"
                  value={form.agencyCode}
                  onChange={(event) => update("agencyCode", event.target.value)}
                  placeholder="SOCAL001"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-tax-id" className={labelClass()}>
                  Tax ID
                </label>
                <input id="wiz-tax-id" value={form.taxId} onChange={(event) => update("taxId", event.target.value)} className={inputClass()} />
              </div>
              <div>
                <label htmlFor="wiz-business-license" className={labelClass()}>
                  Business license
                </label>
                <input
                  id="wiz-business-license"
                  value={form.businessLicense}
                  onChange={(event) => update("businessLicense", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-org-type" className={labelClass()}>
                  Organization type
                </label>
                <input
                  id="wiz-org-type"
                  value={form.orgType}
                  onChange={(event) => update("orgType", event.target.value)}
                  placeholder="Home care agency"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-website" className={labelClass()}>
                  Website
                </label>
                <input id="wiz-website" value={form.website} onChange={(event) => update("website", event.target.value)} className={inputClass()} />
              </div>
              <div>
                <label htmlFor="wiz-timezone" className={labelClass()}>
                  Time zone
                </label>
                <input
                  id="wiz-timezone"
                  value={form.timezone}
                  onChange={(event) => update("timezone", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-currency" className={labelClass()}>
                  Currency
                </label>
                <input
                  id="wiz-currency"
                  value={form.currency}
                  onChange={(event) => update("currency", event.target.value)}
                  className={inputClass()}
                />
              </div>
            </div>
          </Card>
        ) : null}

        {currentStep === "address" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Address</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="wiz-street" className={labelClass()}>
                  Street
                </label>
                <input
                  id="wiz-street"
                  value={form.addressStreet}
                  onChange={(event) => update("addressStreet", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-suite" className={labelClass()}>
                  Suite
                </label>
                <input
                  id="wiz-suite"
                  value={form.addressSuite}
                  onChange={(event) => update("addressSuite", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-city" className={labelClass()}>
                  City
                </label>
                <input id="wiz-city" value={form.addressCity} onChange={(event) => update("addressCity", event.target.value)} className={inputClass()} />
              </div>
              <div>
                <label htmlFor="wiz-state" className={labelClass()}>
                  State
                </label>
                <input
                  id="wiz-state"
                  value={form.addressState}
                  onChange={(event) => update("addressState", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-zip" className={labelClass()}>
                  ZIP
                </label>
                <input id="wiz-zip" value={form.addressZip} onChange={(event) => update("addressZip", event.target.value)} className={inputClass()} />
              </div>
              <div>
                <label htmlFor="wiz-country" className={labelClass()}>
                  Country
                </label>
                <input
                  id="wiz-country"
                  value={form.addressCountry}
                  onChange={(event) => update("addressCountry", event.target.value)}
                  className={inputClass()}
                />
              </div>
            </div>
          </Card>
        ) : null}

        {currentStep === "contact" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Contact</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="wiz-contact-name" className={labelClass()}>
                  Primary contact
                </label>
                <input
                  id="wiz-contact-name"
                  value={form.primaryContactName}
                  onChange={(event) => update("primaryContactName", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-contact-email" className={labelClass()}>
                  Email
                </label>
                <input
                  id="wiz-contact-email"
                  type="email"
                  value={form.contactEmail}
                  onChange={(event) => update("contactEmail", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-contact-phone" className={labelClass()}>
                  Phone
                </label>
                <input
                  id="wiz-contact-phone"
                  value={form.contactPhone}
                  onChange={(event) => update("contactPhone", event.target.value)}
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-emergency-phone" className={labelClass()}>
                  Emergency phone
                </label>
                <input
                  id="wiz-emergency-phone"
                  value={form.emergencyPhone}
                  onChange={(event) => update("emergencyPhone", event.target.value)}
                  className={inputClass()}
                />
              </div>
            </div>
          </Card>
        ) : null}

        {currentStep === "branding" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Branding</h3>
            <p className="mt-1 text-xs text-slate-500">
              Starter branding - a full theme editor is tracked as follow-up work.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="wiz-logo-file" className={labelClass()}>
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
                      id="wiz-logo-file"
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      onChange={(event) => handleLogoFileChange(event.target.files?.[0] ?? null)}
                      className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                    />
                    <p className="mt-1 text-xs text-slate-500">PNG, JPEG, SVG, or WebP - up to 5MB.</p>
                    {logoFile ? (
                      <button
                        type="button"
                        onClick={() => handleLogoFileChange(null)}
                        className="mt-1 text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                {logoError ? <p className="mt-1 text-sm text-red-700">{logoError}</p> : null}
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="wiz-logo" className={labelClass()}>
                  Or a logo URL
                </label>
                <input
                  id="wiz-logo"
                  value={form.logoUrl}
                  onChange={(event) => update("logoUrl", event.target.value)}
                  placeholder="Used only if no file is uploaded above"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-primary-color" className={labelClass()}>
                  Primary color
                </label>
                <input
                  id="wiz-primary-color"
                  value={form.primaryColor}
                  onChange={(event) => update("primaryColor", event.target.value)}
                  placeholder="#0f172a"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-secondary-color" className={labelClass()}>
                  Secondary color
                </label>
                <input
                  id="wiz-secondary-color"
                  value={form.secondaryColor}
                  onChange={(event) => update("secondaryColor", event.target.value)}
                  placeholder="#64748b"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-accent-color" className={labelClass()}>
                  Accent color
                </label>
                <input
                  id="wiz-accent-color"
                  value={form.accentColor}
                  onChange={(event) => update("accentColor", event.target.value)}
                  placeholder="#0ea5e9"
                  className={inputClass()}
                />
              </div>
              <div>
                <label htmlFor="wiz-theme-mode" className={labelClass()}>
                  Theme
                </label>
                <select
                  id="wiz-theme-mode"
                  value={form.themeMode}
                  onChange={(event) => update("themeMode", event.target.value as "light" | "dark")}
                  className={inputClass()}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
            </div>
          </Card>
        ) : null}

        {currentStep === "services" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Services</h3>
            <p className="mt-1 text-xs text-slate-500">
              Starter suggestions - fully editable afterward, and every organization keeps its own independent list.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {SUGGESTED_SERVICES.map((service) => (
                <label key={service} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedServices.includes(service)}
                    onChange={() => toggleService(service)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {service}
                </label>
              ))}
              {selectedServices
                .filter((service) => !SUGGESTED_SERVICES.includes(service))
                .map((service) => (
                  <label key={service} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => toggleService(service)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {service}
                  </label>
                ))}
            </div>
            <div className="mt-4 flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor="wiz-custom-service" className={labelClass()}>
                  Add another service
                </label>
                <input
                  id="wiz-custom-service"
                  value={customService}
                  onChange={(event) => setCustomService(event.target.value)}
                  className={inputClass()}
                />
              </div>
              <button
                type="button"
                onClick={addCustomService}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Add
              </button>
            </div>
          </Card>
        ) : null}

        {currentStep === "administrator" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Administrators</h3>
            <p className="mt-1 text-xs text-slate-500">
              Invite one or more people by email - each sets up their own account, separate from your platform owner
              access.
            </p>
            <div className="mt-4 space-y-3">
              {administrators.map((row, index) => (
                <div key={index} className="flex items-end gap-3">
                  <div className="flex-1">
                    <label htmlFor={`wiz-admin-email-${index}`} className={labelClass()}>
                      Email
                    </label>
                    <input
                      id={`wiz-admin-email-${index}`}
                      type="email"
                      value={row.email}
                      onChange={(event) => updateAdministrator(index, { email: event.target.value })}
                      className={inputClass()}
                    />
                  </div>
                  <div className="w-48">
                    <label htmlFor={`wiz-admin-role-${index}`} className={labelClass()}>
                      Role
                    </label>
                    <select
                      id={`wiz-admin-role-${index}`}
                      value={row.role}
                      onChange={(event) => updateAdministrator(index, { role: event.target.value as InvitableRole })}
                      className={inputClass()}
                    >
                      {invitableRoles.map((roleOption) => (
                        <option key={roleOption} value={roleOption}>
                          {formatRole(roleOption)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAdministratorRow(index)}
                    disabled={administrators.length === 1}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addAdministratorRow}
              className="mt-4 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              + Add another administrator
            </button>
          </Card>
        ) : null}

        {currentStep === "review" ? (
          <Card>
            <h3 className="font-semibold text-slate-950">Review</h3>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Organization</dt>
                <dd className="mt-1 text-sm text-slate-700">{form.legalName || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">URL</dt>
                <dd className="mt-1 text-sm text-slate-700">carelik.com/{form.slug || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Address</dt>
                <dd className="mt-1 text-sm text-slate-700">
                  {[form.addressCity, form.addressState].filter(Boolean).join(", ") || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Contact</dt>
                <dd className="mt-1 text-sm text-slate-700">{form.contactEmail || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Services</dt>
                <dd className="mt-1 text-sm text-slate-700">{selectedServices.join(", ") || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Administrators</dt>
                <dd className="mt-1 text-sm text-slate-700">
                  {administrators.filter((row) => row.email.trim()).length > 0
                    ? administrators
                        .filter((row) => row.email.trim())
                        .map((row) => `${row.email} (${formatRole(row.role)})`)
                        .join(", ")
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Logo</dt>
                <dd className="mt-1 text-sm text-slate-700">
                  {logoPreviewUrl ? (
                    <img src={logoPreviewUrl} alt="Logo preview" className="h-10 w-10 rounded border border-slate-200 object-contain" />
                  ) : (
                    form.logoUrl || "—"
                  )}
                </dd>
              </div>
            </dl>
          </Card>
        ) : null}

        {stepError ? <p className="text-sm text-red-700">{stepError}</p> : null}
        {currentStep === "review" && submitError ? <p className="text-sm text-red-700">{submitError}</p> : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={goPrevious}
            disabled={stepIndex === 0}
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          {currentStep === "review" ? (
            <button
              type="button"
              onClick={handleFinalSubmit}
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Creating…" : "Create organization"}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              className="rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
