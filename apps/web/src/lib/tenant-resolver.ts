/**
 * Tenant Resolution Layer
 * Determines whether a request is for the Platform (carelik management) or
 * a Tenant (agency workspace). This is the single source of truth for
 * application routing and context.
 */

/**
 * Detects whether the current request is for the Platform or a Tenant.
 *
 * Platform: platform.carelik.com, carelik.com (root)
 * Tenant: {slug}.carelik.com, custom domains
 *
 * Returns null if unable to determine (e.g., missing organization context
 * after auth when a tenant app is expected).
 */
export function resolveTenant(hostname: string | undefined): { type: "platform" | "tenant"; slug?: string } {
  if (!hostname) {
    return { type: "platform" };
  }

  // Strip port for development
  const host = hostname.split(":")[0];

  // Platform detection
  if (!host || host === "carelik.com" || host === "localhost" || host === "platform.carelik.com") {
    return { type: "platform" };
  }

  // Tenant detection: extract subdomain
  const parts = host.split(".");
  if (parts.length >= 2) {
    const subdomain = parts[0];
    if (!subdomain) {
      return { type: "platform" };
    }
    // Platform subdomains
    if (["platform", "www", "admin", "api"].includes(subdomain)) {
      return { type: "platform" };
    }
    // Tenant subdomain
    return { type: "tenant", slug: subdomain };
  }

  return { type: "platform" };
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
