/**
 * Tenant Resolution Layer
 * Determines which of Ogevia's fixed areas a request belongs to - the
 * public marketing site, the shared multi-tenant application, or platform
 * administration. This is the single source of truth for application
 * routing and context.
 */

// Wildcard subdomains (*.ogevia.com) turned out to need a paid Netlify plan
// plus manual Netlify Support approval - not something to block launch on.
// So launch uses three fixed, ordinary hosts instead: ogevia.com (public
// marketing), app.ogevia.com (one shared host for every organization -
// which org a logged-in user is working in is resolved from their own
// organization_memberships, not the hostname - see
// organization-provider.tsx), and admin.ogevia.com (platform admin).
//
// The older per-tenant-subdomain model ({slug}.ogevia.com) is NOT deleted -
// "tenant" stays a valid resolved type below, so it keeps working the
// moment wildcard DNS is ever approved. It's just no longer what launch
// depends on; app.ogevia.com is the real front door now.
export type PlatformArea = "marketing" | "app" | "admin" | "tenant";

export interface TenantContext {
  type: PlatformArea;
  slug?: string;
}

// ".localhost" entries are for local dev only (see the Verification
// Commands section of docs/BUILD_022_MULTI_TENANT_ARCHITECTURE.md).
// carelik.com is kept working alongside ogevia.com during the CareLik ->
// Ogevia rebrand - remove it only once DNS/Netlify/Supabase redirect URLs
// have fully cut over and it's no longer receiving traffic.
const OWN_DOMAIN_SUFFIXES = [".ogevia.com", ".carelik.com", ".localhost"];

const MARKETING_HOSTS = ["ogevia.com", "www.ogevia.com", "carelik.com", "www.carelik.com"];
const APP_HOSTS = ["app.ogevia.com", "app.carelik.com", "app.localhost"];
const ADMIN_HOSTS = [
  "admin.ogevia.com",
  "admin.localhost",
  // Legacy platform host names, kept working during the cutover to
  // admin.ogevia.com.
  "platform.ogevia.com",
  "platform.carelik.com"
];

// Subdomains that must never be interpreted as a legacy tenant slug -
// "app"/"admin"/"platform" are this app's own fixed hosts (handled above
// before this list is even consulted), "www"/"api" are conventional
// reservations.
const RESERVED_SUBDOMAINS = ["app", "platform", "www", "admin", "api"];

/**
 * Resolves which fixed area a hostname belongs to. Unrecognized hosts
 * (including bare "localhost") default to "marketing" - the public site is
 * the correct front door for anything that isn't explicitly one of
 * Ogevia's own hosts.
 *
 * A hostname that isn't one of Ogevia's own domains (a tenant's custom
 * domain) also resolves to "marketing" here, since resolving those
 * requires a database lookup - see useTenantContext() in
 * use-tenant-context.ts for the async resolution that also checks
 * organizations.custom_domain.
 */
export function resolveTenant(hostname: string | undefined): TenantContext {
  if (!hostname) {
    return { type: "marketing" };
  }

  // Strip port for development
  const host = hostname.split(":")[0];

  if (!host || host === "localhost") {
    return { type: "marketing" };
  }
  if (MARKETING_HOSTS.includes(host)) {
    return { type: "marketing" };
  }
  if (APP_HOSTS.includes(host)) {
    return { type: "app" };
  }
  if (ADMIN_HOSTS.includes(host)) {
    return { type: "admin" };
  }

  // Legacy/optional path: {slug}.ogevia.com or {slug}.carelik.com or
  // {slug}.localhost - still resolved, still usable the moment wildcard
  // DNS exists, just not what launch depends on.
  const suffix = OWN_DOMAIN_SUFFIXES.find((candidate) => host.endsWith(candidate));
  if (!suffix) {
    // Not one of Ogevia's own domains - might be a tenant's custom
    // domain, resolved separately and asynchronously.
    return { type: "marketing" };
  }

  const subdomain = host.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes(".")) {
    // Empty, or a nested subdomain like a.b.ogevia.com - not a valid
    // tenant slug.
    return { type: "marketing" };
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return { type: "marketing" };
  }

  return { type: "tenant", slug: subdomain };
}

/**
 * True when resolveTenant() can resolve this hostname on its own
 * (Ogevia's own domains). False means the hostname needs the async
 * organizations.custom_domain lookup to know whether it's a tenant.
 */
export function isOwnDomain(hostname: string | undefined): boolean {
  if (!hostname) return true;
  const host = hostname.split(":")[0];
  if (!host || host === "localhost") {
    return true;
  }
  if (MARKETING_HOSTS.includes(host) || APP_HOSTS.includes(host) || ADMIN_HOSTS.includes(host)) {
    return true;
  }
  return OWN_DOMAIN_SUFFIXES.some((candidate) => host.endsWith(candidate));
}

/**
 * Get current tenant context from browser location
 */
export function getCurrentTenantContext() {
  return resolveTenant(window.location.hostname);
}

/**
 * Redirect to the platform admin URL (admin.ogevia.com).
 */
export function toAdminUrl(path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//admin.ogevia.com${port}`;
  return `${baseUrl}${path}`;
}

/**
 * Redirect to the shared application URL (app.ogevia.com) - which
 * organization loads is resolved from the signed-in user's own
 * memberships, not from this URL. Pass path="/?org=<slug>" to deep-link a
 * preferred organization - see organization-provider.tsx.
 */
export function toAppUrl(path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//app.ogevia.com${port}`;
  return `${baseUrl}${path}`;
}

/**
 * Redirect to a legacy per-tenant subdomain URL. Only resolves in
 * production once wildcard DNS is approved - see the PlatformArea comment
 * above. Kept working for whenever that happens.
 */
export function toTenantUrl(slug: string, path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//${slug}.ogevia.com${port}`;
  return `${baseUrl}${path}`;
}
