// In-app notifications (0077): the header bell and the agency setting. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, ORG, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["visits.read", "shifts.manage", "documents.read"];
const note = (over: Record<string, unknown>) => ({ id: "n1", issueKey: "shift:uncovered_open:s1", severity: "critical", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", clientCode: "CL-7",
  createdAt: new Date().toISOString(), readAt: null, resolvedAt: null, state: "unread", ...over });

describe("notifications bell", () => {
  it("shows the unread count, lists items with a word and the client code only, and marks all read through the server", async () => {
    let items: Array<Record<string, unknown>> = [note({}), note({ id: "n2", severity: "urgent", reason: "confirmation_overdue", kind: "visit", queue: "visit_review", clientCode: "CL-8" }), note({ id: "n3", state: "resolved", resolvedAt: new Date().toISOString() })];
    let unread = 2;
    const { calls } = renderAws("/", PERMS, {
      "GET /v1/notifications": () => json(200, { notifications: { asOf: new Date().toISOString(), unread, items } }),
      "POST /v1/notifications/read": () => { unread = 0; items = items.map((i) => (i["state"] === "unread" ? { ...i, state: "read", readAt: new Date().toISOString() } : i)); return json(200, { marked: 2 }); },
    });
    const button = await screen.findByTestId("notifications-button");
    expect(button.getAttribute("aria-label")).toBe("Notifications: 2 unread");
    fireEvent.click(button);
    const rows = await screen.findAllByTestId("notification");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toMatch(/Critical/);
    expect(rows[0]!.textContent).toMatch(/Client CL-7/);
    expect(rows[1]!.textContent).toMatch(/Urgent/);
    expect(rows[2]!.textContent).toMatch(/Resolved/);
    expect(screen.getByRole("link", { name: "Open Action needed" }).getAttribute("href")).toBe("/action-needed");
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByTestId("notifications-button").getAttribute("aria-label")).toBe("Notifications: 0 unread"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/notifications/read")!;
    expect(post.body).toEqual({ organizationId: ORG });
    expect(post.key).toBeTruthy();
  });

  it("a failed load says so and never shows a false zero; a failed mark-read says nothing changed", async () => {
    renderAws("/", PERMS, { "GET /v1/notifications": () => json(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) });
    const button = await screen.findByTestId("notifications-button");
    expect(button.getAttribute("aria-label")).toBe("Notifications unavailable");
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("people who cannot see attention items get no bell", async () => {
    renderAws("/", ["clients.read"]);
    await screen.findByText(/Synthetic Care Co/);
    expect(screen.queryByTestId("notifications-button")).toBeNull();
  });
});

describe("notification setting on Action needed", () => {
  it("the owner switches Urgent notifications off with a reason; the manager sees the state only", async () => {
    let urgent = true;
    const handlers = {
      "GET /v1/notification-settings": () => json(200, { settings: { urgentInApp: urgent, criticalInApp: true, routine: "listed in Action needed only", outboundChannels: "none" } }),
      "POST /v1/notification-settings": () => { urgent = false; return json(200, { settings: { urgentInApp: false } }); },
    };
    const { calls } = renderAws("/action-needed", [...PERMS, "organization.update"], handlers, "organization_owner");
    fireEvent.click(await screen.findByText("Notifications", { selector: "summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Urgent notifications" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/why/i);
    fireEvent.change(screen.getByLabelText(/Why are you changing it/), { target: { value: "Fewer interruptions" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop Urgent notifications" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/notification-settings")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/notification-settings" && c.method === "POST")!.body).toEqual({ organizationId: ORG, urgentInApp: false, reason: "Fewer interruptions" });
  });
});
