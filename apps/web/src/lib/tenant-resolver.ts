/**
 * Tenant Resolution Layer
 * Determines whether a request is for the Platform (carelik management) or
 * a Tenant (agency workspace). This is the single source of truth for
 * application routing and context.
 */

export interface TenantContext {
  type: "platform" | "tenant";
  slug?: string;
}

// CareLik's own hosts, in prod and local dev - a hostname ending in one
// of these can be resolved to a tenant slug synchronously, no database
// lookup needed, since the slug is just the first label. ".localhost" is
// here purely for local dev (see the Verification Commands section of
// docs/BUILD_022_MULTI_TENANT_ARCHITECTURE.md: http://tenant.localhost:5173).
const OWN_DOMAIN_SUFFIXES = [".carelik.com", ".localhost"];

const RESERVED_SUBDOMAINS = ["platform", "www", "admin", "api"];

/**
 * Detects whether the current request is for the Platform or a Tenant,
 * for a hostname that is recognizably CareLik's own (platform host, or
 * `{slug}.carelik.com` / `{slug}.localhost`).
 *
 * Platform: platform.carelik.com, carelik.com (root), localhost
 * Tenant: {slug}.carelik.com, {slug}.localhost
 *
 * A hostname that isn't one of CareLik's own domains (a tenant's custom
 * domain) always resolves to "platform" here, since resolving those
 * requires a database lookup - see useTenantContext() in
 * use-tenant-context.ts for the async resolution that also checks
 * organizations.custom_domain.
 */
export function resolveTenant(hostname: string | undefined): TenantContext {
  if (!hostname) {
    return { type: "platform" };
  }

  // Strip port for development
  const host = hostname.split(":")[0];

  // Platform detection
  if (!host || host === "carelik.com" || host === "localhost" || host === "platform.carelik.com") {
    return { type: "platform" };
  }

  const suffix = OWN_DOMAIN_SUFFIXES.find((candidate) => host.endsWith(candidate));
  if (!suffix) {
    // Not one of CareLik's own domains - might be a tenant's custom
    // domain, resolved separately and asynchronously.
    return { type: "platform" };
  }

  const subdomain = host.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes(".")) {
    // Empty, or a nested subdomain like a.b.carelik.com - not a valid
    // tenant slug.
    return { type: "platform" };
  }
  if (RESERVED_SUBDOMAINS.includes(subdomain)) {
    return { type: "platform" };
  }

  return { type: "tenant", slug: subdomain };
}

/**
 * True when resolveTenant() can resolve this hostname on its own
 * (CareLik's own domains). False means the hostname needs the async
 * organizations.custom_domain lookup to know whether it's a tenant.
 */
export function isOwnDomain(hostname: string | undefined): boolean {
  if (!hostname) return true;
  const host = hostname.split(":")[0];
  if (!host || host === "carelik.com" || host === "localhost" || host === "platform.carelik.com") {
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
 * Redirect to platform URL
 */
export function toPlatformUrl(path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//platform.carelik.com${port}`;
  return `${baseUrl}${path}`;
}

/**
 * Redirect to tenant URL
 */
export function toTenantUrl(slug: string, path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//${slug}.carelik.com${port}`;
  return `${baseUrl}${path}`;
}
