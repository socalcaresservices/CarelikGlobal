import { describe, expect, it } from "vitest";
import { resolveTenant, toAppUrl, toMarketingUrl } from "./tenant-resolver";

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

  it("strips the port before resolving", () => {
    expect(resolveTenant("app.ogevia.com:5173")).toEqual({ type: "app" });
  });

  // The Ogevia Architecture Reset eliminates hostname-based tenant/admin
  // resolution entirely - organizations are selected by URL path
  // (/org/:slug) under app.ogevia.com, and platform administration is a
  // path (/platform) under the same host, not a separate admin.ogevia.com
  // or {slug}.ogevia.com host. Any hostname that isn't explicitly one of
  // Ogevia's own two hosts (marketing or app) falls back to marketing -
  // there is no third "admin" or "tenant" area left to resolve to.
  it("falls back to marketing for a hostname that used to resolve as admin or a tenant subdomain", () => {
    expect(resolveTenant("admin.ogevia.com")).toEqual({ type: "marketing" });
    expect(resolveTenant("platform.ogevia.com")).toEqual({ type: "marketing" });
    expect(resolveTenant("acme.ogevia.com")).toEqual({ type: "marketing" });
    expect(resolveTenant("acme.localhost")).toEqual({ type: "marketing" });
  });

  it("does not guess anything from an arbitrary external domain", () => {
    expect(resolveTenant("google.com")).toEqual({ type: "marketing" });
    expect(resolveTenant("app.acme-agency.com")).toEqual({ type: "marketing" });
  });
});

describe("toAppUrl / toMarketingUrl", () => {
  // jsdom's default test location is http://localhost:3000/ - these
  // build from window.location.protocol/port, so that's what shows up
  // here rather than a hardcoded https with no port.
  it("builds an app URL, optionally with a path", () => {
    expect(toAppUrl()).toBe("http://app.ogevia.com:3000");
    expect(toAppUrl("/login")).toBe("http://app.ogevia.com:3000/login");
    expect(toAppUrl("/platform/organizations")).toBe("http://app.ogevia.com:3000/platform/organizations");
  });

  it("builds a marketing URL, optionally with a path", () => {
    expect(toMarketingUrl()).toBe("http://ogevia.com:3000");
    expect(toMarketingUrl("/pricing")).toBe("http://ogevia.com:3000/pricing");
  });
});
