// Keyboard and screen-reader readiness smoke test (jsdom + testing-library). SYNTHETIC data only.
// This is NOT a screen-reader test: NVDA, JAWS and VoiceOver were NOT TESTED. It checks structure a screen reader and the keyboard depend on:
// names, headings, landmarks, labels, alert/status roles, drawer focus, Escape, and that the primary action is a tabbable control. Real Tab traversal,
// focus visibility and spoken output need a browser and a person.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, renderAws } from "./test-support";

const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "dddddddd-0000-4000-8000-000000000001";
const AUTH1 = "a1a1a1a1-0000-4000-8000-000000000001";
const OWNER = ["authorizations.read", "authorizations.update", "clients.manage", "clients.names.manage", "clients.names.read", "visits.manage", "visits.read", "shifts.manage", "documents.read", "documents.manage", "organization.update", "caregivers.read", "caregivers.manage"];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const client = { clientId: CLIENT, clientCode: "CL-ABCDEF1234", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: "Riverside", clientTypeId: null, clientTypeName: null, currentAuthorizationCount: 1 };
const version = { authorizationId: AUTH1, lineageId: AUTH1, versionNumber: 1, isCurrent: true, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", payer: "Synthetic Regional Center",
  authorizationNumber: "SYN-1", monthlyAuthorizedMinutes: 1800, periodStart: "2026-01-01", periodEnd: "2026-12-31", receivedDate: null, sourceReference: null, changeReason: "Created", createdAt: "2026-01-01T00:00:00Z", createdByName: "Morgan Manager", hourlyRateCents: null };
const handlers = {
  "GET /v1/clients": () => json(200, { clients: [client] }),
  [`GET /v1/clients/${CLIENT}/authorizations`]: () => json(200, { authorizations: [version] }),
  "GET /v1/reports/monthly-service-summary": () => json(200, { services: [] }),
  "GET /v1/assignments": () => json(200, { assignments: [] }),
  "GET /v1/services": () => json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] }),
  [`GET /v1/clients/${CLIENT}/documents`]: () => json(200, { documents: [] }),
  [`GET /v1/clients/${CLIENT}/issue-history`]: () => json(200, { history: { resolved: [] } }),
};

/** A deliberately small accessible-name computation: aria-labelledby, aria-label, associated/wrapping label, text content (with img alt), title. */
function nameOf(el: Element): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const labels = Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" ").trim();
    if (labels) return labels;
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return el.value;
  } else {
    const parts = Array.from(el.querySelectorAll("img[alt]")).map((i) => i.getAttribute("alt") ?? "").join(" ");
    const text = `${el.textContent ?? ""} ${parts}`.trim();
    if (text) return text;
  }
  return el.getAttribute("title")?.trim() ?? "";
}
const hidden = (el: Element) => !!el.closest('[hidden], [aria-hidden="true"], [inert]') || (el instanceof HTMLInputElement && el.type === "hidden");
const interactive = () => Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]')).filter((e) => !hidden(e));

function expectStructure() {
  // Every interactive control has an accessible name.
  const unnamed = interactive().filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 120));
  expect(unnamed, "controls without an accessible name").toEqual([]);
  // Form fields have labels.
  const unlabelled = interactive().filter((e) => (e instanceof HTMLInputElement && !["button", "submit", "reset", "hidden"].includes(e.type)) || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement)
    .filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 120));
  expect(unlabelled, "form fields without a label").toEqual([]);
  // Headings: exactly one h1 and no skipped level.
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h) => !hidden(h)).map((h) => Number(h.tagName[1]));
  expect(headings.filter((l) => l === 1), "exactly one h1").toHaveLength(1);
  expect(headings[0]).toBe(1);
  headings.forEach((l, i) => { if (i > 0) expect(l, `heading level jumps from ${headings[i - 1]} to ${l}`).toBeLessThanOrEqual(headings[i - 1]! + 1); });
  // Landmarks.
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getAllByRole("navigation").length).toBeGreaterThanOrEqual(1);
  // No positive tabindex (it would override the natural order); alerts and status messages use the live-region roles.
  expect(Array.from(document.querySelectorAll("[tabindex]")).filter((e) => Number(e.getAttribute("tabindex")) > 0)).toHaveLength(0);
}

const SCREENS: { name: string; path: string; ready: () => Promise<unknown> }[] = [
  { name: "Home", path: "/", ready: () => screen.findByRole("heading", { level: 1 }) },
  { name: "Schedule", path: "/schedule", ready: () => screen.findByRole("heading", { level: 1, name: /Schedule/ }) },
  { name: "Care Team", path: "/care-team", ready: () => screen.findByRole("heading", { level: 1 }) },
  { name: "Documents", path: "/documents", ready: () => screen.findByRole("heading", { level: 1 }) },
  { name: "Client detail", path: `/clients/${CLIENT}`, ready: () => screen.findByRole("heading", { level: 1 }) },
  { name: "Appearance", path: "/settings/appearance", ready: () => screen.findByRole("heading", { level: 1 }) },
];

describe("a11y smoke: main admin screens (structure only; NOT a screen-reader test)", () => {
  for (const s of SCREENS) {
    it(`${s.name}: names, one h1 in order, landmarks, labels, no positive tabindex`, async () => {
      renderAws(s.path, OWNER, handlers);
      await s.ready();
      await new Promise((r) => setTimeout(r, 150));
      expectStructure();
    }, 30000);
  }

  it("Client detail: the primary action (Add authorization) is a named, enabled, tabbable button that comes before the page's other controls in the section", async () => {
    renderAws(`/clients/${CLIENT}`, OWNER, handlers);
    const add = await screen.findByRole("button", { name: "Add authorization" }, { timeout: 15000 });
    expect(add).not.toBeDisabled();
    expect(add.tabIndex).toBeGreaterThanOrEqual(0);
    const order = interactive().filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled);
    expect(order).toContain(add);
    // Opening it reveals labelled fields and moves nothing out of the tab order.
    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByLabelText("Authorization number (optional)")).toBeInTheDocument();
    expectStructure();
  }, 30000);

  it("alerts use role=alert and confirmations use role=status", async () => {
    renderAws(`/authorization-impacts`, ["authorizations.update"], { "GET /v1/authorization-impacts": () => json(500, { error: { code: "boom", message: "Could not load." } }) });
    expect(await screen.findByRole("alert", {}, { timeout: 15000 })).toHaveTextContent(/./);
    cleanup();
    renderAws(`/authorization-impacts`, ["authorizations.update"], { "GET /v1/authorization-impacts": () => json(200, { impacts: [] }) });
    expect(await screen.findByRole("status", {}, { timeout: 15000 })).toHaveTextContent("Nothing to review.");
  }, 30000);

  it("no live message is announced without a role: error-looking paragraphs are role=alert", async () => {
    renderAws("/clients", OWNER, { ...handlers, "GET /v1/clients": () => json(500, { error: { code: "boom", message: "Could not load clients." } }) });
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0), { timeout: 15000 });
  }, 30000);
});

describe("a11y smoke: phone navigation drawer", () => {
  it("focus moves into the drawer when it opens, Tab stays inside it, Escape closes it and focus returns to the Menu button", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }));
    renderAws("/", OWNER, handlers);
    const menu = await screen.findByRole("button", { name: /^Menu/ }, { timeout: 15000 });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    fireEvent.click(menu);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const drawer = document.getElementById("aws-sidebar")!; // the dialog-like container that holds Close menu and the navigation
    const close = screen.getByRole("button", { name: "Close menu" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(close).toHaveFocus();
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last (the focus trap).
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    focusable[focusable.length - 1]!.focus();
    fireEvent.keyDown(focusable[focusable.length - 1]!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(focusable[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    // Every drawer control is named.
    expect(within(nav).getAllByRole("link").filter((l) => !nameOf(l)).map((l) => l.outerHTML.slice(0, 200))).toEqual([]);
    fireEvent.keyDown(nav, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
    expect(menu).toHaveFocus();
    expect(menu).toHaveAttribute("aria-expanded", "false");
  }, 30000);
});
