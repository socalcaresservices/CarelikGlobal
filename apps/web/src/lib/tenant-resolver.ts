/**
 * Host Resolution Layer
 *
 * Ogevia Architecture Reset: the platform and every tenant now live under
 * ONE authenticated host (app.ogevia.com), with the tenant/platform split
 * decided by URL PATH (/org/:slug vs /platform), not by hostname. This
 * replaces the earlier three/four-host model (app./admin./{slug}.ogevia.com)
 * entirely - there is no "admin" or "tenant" PlatformArea anymore. See
 * App.tsx for the path-based routing this feeds, and
 * organization-provider.tsx for how :orgSlug resolves to an authorized
 * organization (never the hostname, and never localStorage).
 *
 * Only two areas are left to resolve by hostname, because they're
 * genuinely different hosts: the public marketing site (ogevia.com) and
 * everything authenticated (app.ogevia.com). An unrecognized hostname
 * defaults to marketing - the public site is the correct front door for
 * anything that isn't explicitly Ogevia's own app host.
 */
export type PlatformArea = "marketing" | "app";

export interface TenantContext {
  type: PlatformArea;
}

const APP_HOSTS = ["app.ogevia.com", "app.carelik.com", "app.localhost"];

/**
 * Resolves which host area (marketing or app) a hostname belongs to.
 * Bare "localhost" and anything else not explicitly one of Ogevia's own
 * hosts resolves to "marketing".
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
  if (APP_HOSTS.includes(host)) {
    return { type: "app" };
  }
  // Everything else - ogevia.com/carelik.com explicitly, and any
  // unrecognized hostname (a custom domain, an external referrer) - is
  // the marketing default.
  return { type: "marketing" };
}

/**
 * Redirect to the authenticated application host (app.ogevia.com).
 * Pass a path like "/login" or "/org/<slug>"; defaults to the app root,
 * which resolves the signed-in user into their organization (or
 * /select-organization, or /platform) - see AppRootRedirect.
 */
export function toAppUrl(path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//app.ogevia.com${port}`;
  return `${baseUrl}${path}`;
}

/**
 * Redirect to the public marketing site (ogevia.com). Used from within
 * the app - e.g. PlatformShell's "View public website" - which lives on
 * a different host now that platform administration is a path
 * (app.ogevia.com/platform), not its own host.
 */
export function toMarketingUrl(path: string = "") {
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : "";
  const baseUrl = `${protocol}//ogevia.com${port}`;
  return `${baseUrl}${path}`;
}
