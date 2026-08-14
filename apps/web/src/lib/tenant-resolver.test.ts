import { describe, expect, it } from "vitest";
import { isOwnDomain, resolveTenant, toAdminUrl, toAppUrl, toTenantUrl } from "./tenant-resolver";

describe("resolveTenant", () => {
  it("treats a missing hostname as marketing", () => {
    expect(resolveTenant(undefined)).toEqual({ type: "marketing" });
  });

  it.each(["ogevia.com", "www.ogevia.com", "carelik.com", "www.carelik.com", "localhost"])(
    "treats %s as marketing",
    (hostname) => {
      expect(resolveTenant(hostname)).toEqual({ type: "marketing" });
    }
  );

  it.each(["app.ogevia.com", "app.carelik.com", "app.localhost"])("treats %s as the app workspace", (hostname) => {
    expect(resolveTenant(hostname)).toEqual({ type: "app" });
  });

  it("treats a Netlify deploy preview as the app workspace", () => {
    expect(resolveTenant("deploy-preview-5--carelikglobal.netlify.app")).toEqual({ type: "app" });
  });

  it("keeps the production Netlify hostname on the marketing site", () => {
    expect(resolveTenant("carelikglobal.netlify.app")).toEqual({ type: "marketing" });
  });

  it.each(["admin.ogevia.com", "admin.localhost", "platform.ogevia.com", "platform.carelik.com"])(
    "treats %s as admin",
    (hostname) => {
      expect(resolveTenant(hostname)).toEqual({ type: "admin" });
    }
  );

  it("strips the port before resolving", () => {
    expect(resolveTenant("app.ogevia.com:5173")).toEqual({ type: "app" });
    expect(resolveTenant("acme.ogevia.com:5173")).toEqual({ type: "tenant", slug: "acme" });
  });

  // Legacy per-tenant subdomain resolution - not what launch depends on
  // (needs wildcard DNS), but kept working for whenever that's available.
  it("resolves a {slug}.ogevia.com host to a tenant", () => {
    expect(resolveTenant("acme.ogevia.com")).toEqual({ type: "tenant", slug: "acme" });
  });

  // carelik.com stays live alongside ogevia.com during the rebrand - see
  // the OWN_DOMAIN_SUFFIXES comment in tenant-resolver.ts.
  it("still resolves a {slug}.carelik.com host to a tenant during the rebrand", () => {
    expect(resolveTenant("acme.carelik.com")).toEqual({ type: "tenant", slug: "acme" });
  });

  it("resolves a {slug}.localhost host to a tenant, for local dev", () => {
    expect(resolveTenant("acme.localhost")).toEqual({ type: "tenant", slug: "acme" });
  });

  // "app"/"platform"/"admin"/"www" are covered by the fixed-host tests
  // above (they resolve as their own dedicated area before reaching this
  // fallback at all) - "api" is the one reserved name with no fixed host
  // of its own, so it's what actually exercises RESERVED_SUBDOMAINS.
  it("treats the reserved subdomain api.ogevia.com as marketing, not a tenant slug", () => {
    expect(resolveTenant("api.ogevia.com")).toEqual({ type: "marketing" });
  });

  it("does not treat a nested subdomain as a valid tenant slug", () => {
    expect(resolveTenant("a.b.ogevia.com")).toEqual({ type: "marketing" });
  });

  // Regression: the original implementation guessed a tenant slug from
  // the first label of *any* two-part hostname, so a real external
  // domain like "google.com" or a tenant's own custom domain would have
  // resolved as {type: "tenant", slug: "google"} - silently wrong, and
  // unsafe once custom domains are a real feature (see
  // use-tenant-context.ts for how those are actually resolved, via a
  // database lookup rather than a guess).
  it("does not guess a tenant slug from an arbitrary external domain", () => {
    expect(resolveTenant("google.com")).toEqual({ type: "marketing" });
    expect(resolveTenant("app.acme-agency.com")).toEqual({ type: "marketing" });
  });
});

describe("isOwnDomain", () => {
  it("is true for Ogevia's own hosts", () => {
    expect(isOwnDomain(undefined)).toBe(true);
    expect(isOwnDomain("ogevia.com")).toBe(true);
    expect(isOwnDomain("localhost")).toBe(true);
    expect(isOwnDomain("app.ogevia.com")).toBe(true);
    expect(isOwnDomain("admin.ogevia.com")).toBe(true);
    expect(isOwnDomain("platform.ogevia.com")).toBe(true);
    expect(isOwnDomain("acme.ogevia.com")).toBe(true);
    expect(isOwnDomain("acme.localhost")).toBe(true);
    expect(isOwnDomain("deploy-preview-5--carelikglobal.netlify.app")).toBe(true);
  });

  it("is still true for carelik.com hosts during the rebrand", () => {
    expect(isOwnDomain("carelik.com")).toBe(true);
    expect(isOwnDomain("platform.carelik.com")).toBe(true);
    expect(isOwnDomain("acme.carelik.com")).toBe(true);
  });

  it("is false for a hostname that could be a tenant's custom domain", () => {
    expect(isOwnDomain("app.acme-agency.com")).toBe(false);
    expect(isOwnDomain("google.com")).toBe(false);
  });
});

describe("toAdminUrl / toAppUrl / toTenantUrl", () => {
  // jsdom's default test location is http://localhost:3000/ - these
  // build from window.location.protocol/port, so that's what shows up
  // here rather than a hardcoded https with no port.
  it("builds an admin URL from the current protocol and port", () => {
    expect(toAdminUrl("/organizations")).toBe("http://admin.ogevia.com:3000/organizations");
  });

  it("builds an app URL, optionally with an ?org= deep link", () => {
    expect(toAppUrl()).toBe("http://app.ogevia.com:3000");
    expect(toAppUrl("/?org=acme")).toBe("http://app.ogevia.com:3000/?org=acme");
  });

  it("builds a legacy tenant URL for a given slug", () => {
    expect(toTenantUrl("acme", "/settings")).toBe("http://acme.ogevia.com:3000/settings");
  });
});
