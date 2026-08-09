import { describe, expect, it } from "vitest";
import { isOwnDomain, resolveTenant, toPlatformUrl, toTenantUrl } from "./tenant-resolver";

describe("resolveTenant", () => {
  it("treats a missing hostname as platform", () => {
    expect(resolveTenant(undefined)).toEqual({ type: "platform" });
  });

  it.each(["carelik.com", "localhost", "platform.carelik.com"])(
    "treats %s as platform",
    (hostname) => {
      expect(resolveTenant(hostname)).toEqual({ type: "platform" });
    }
  );

  it("strips the port before resolving", () => {
    expect(resolveTenant("localhost:5173")).toEqual({ type: "platform" });
    expect(resolveTenant("acme.carelik.com:5173")).toEqual({ type: "tenant", slug: "acme" });
  });

  it("resolves a {slug}.carelik.com host to a tenant", () => {
    expect(resolveTenant("acme.carelik.com")).toEqual({ type: "tenant", slug: "acme" });
  });

  it("resolves a {slug}.localhost host to a tenant, for local dev", () => {
    expect(resolveTenant("acme.localhost")).toEqual({ type: "tenant", slug: "acme" });
  });

  it.each(["platform", "www", "admin", "api"])(
    "treats the reserved subdomain %s.carelik.com as platform, not a tenant slug",
    (subdomain) => {
      expect(resolveTenant(`${subdomain}.carelik.com`)).toEqual({ type: "platform" });
    }
  );

  it("does not treat a nested subdomain as a valid tenant slug", () => {
    expect(resolveTenant("a.b.carelik.com")).toEqual({ type: "platform" });
  });

  // Regression: the original implementation guessed a tenant slug from
  // the first label of *any* two-part hostname, so a real external
  // domain like "google.com" or a tenant's own custom domain would have
  // resolved as {type: "tenant", slug: "google"} - silently wrong, and
  // unsafe once custom domains are a real feature (see
  // use-tenant-context.ts for how those are actually resolved, via a
  // database lookup rather than a guess).
  it("does not guess a tenant slug from an arbitrary external domain", () => {
    expect(resolveTenant("google.com")).toEqual({ type: "platform" });
    expect(resolveTenant("app.acme-agency.com")).toEqual({ type: "platform" });
  });
});

describe("isOwnDomain", () => {
  it("is true for CareLik's own hosts", () => {
    expect(isOwnDomain(undefined)).toBe(true);
    expect(isOwnDomain("carelik.com")).toBe(true);
    expect(isOwnDomain("localhost")).toBe(true);
    expect(isOwnDomain("platform.carelik.com")).toBe(true);
    expect(isOwnDomain("acme.carelik.com")).toBe(true);
    expect(isOwnDomain("acme.localhost")).toBe(true);
  });

  it("is false for a hostname that could be a tenant's custom domain", () => {
    expect(isOwnDomain("app.acme-agency.com")).toBe(false);
    expect(isOwnDomain("google.com")).toBe(false);
  });
});

describe("toPlatformUrl / toTenantUrl", () => {
  // jsdom's default test location is http://localhost:3000/ - these
  // build from window.location.protocol/port, so that's what shows up
  // here rather than a hardcoded https with no port.
  it("builds a platform URL from the current protocol and port", () => {
    expect(toPlatformUrl("/organizations")).toBe("http://platform.carelik.com:3000/organizations");
  });

  it("builds a tenant URL for a given slug", () => {
    expect(toTenantUrl("acme", "/settings")).toBe("http://acme.carelik.com:3000/settings");
  });
});
