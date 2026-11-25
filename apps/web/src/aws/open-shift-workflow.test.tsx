/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles: request bodies are free-form JSON */
// The open-shift workflow on screen (0063 + 0117): the caregiver board (service city, coordinating office, request, withdraw), the office queue (earliest eligible request
// preselected, only the office confirms), and the texting panels (own opt-in, owner settings, on-call numbers; hidden where the switch is off). SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const later = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const SHIFT = "51515151-0000-4000-8000-000000000001";
const openShift = { shiftId: SHIFT, startsAt: later(30), endsAt: later(32), minutes: 120, clientCode: "CL-1", city: "Winchester", officeName: "Temecula Office", serviceName: "Personal care", coverageState: "needs_coverage", myRequestStatus: null as "requested" | null };

describe("caregiver Open Shifts board", () => {
  it("shows the SERVICE city and the coordinating office; requesting and withdrawing change only the caregiver's own request", async () => {
    let mine: "requested" | null = null;
    const { calls } = renderAws("/my-shifts", [], {
      "GET /v1/open-shifts": () => json(200, { shifts: [{ ...openShift, myRequestStatus: mine }] }),
      "GET /v1/my-shifts": () => json(200, { shifts: [] }),
      [`POST /v1/shifts/${SHIFT}/pickup`]: () => { mine = "requested"; return json(200, { pickupState: "requested" }); },
      [`POST /v1/shifts/${SHIFT}/pickup/withdraw`]: () => { mine = null; return json(200, { pickupState: "withdrawn" }); },
    });
    const board = await screen.findByRole("heading", { name: "Open shifts you can ask for" }, { timeout: 15000 });
    const section = board.closest("section")!;
    expect(section).toHaveTextContent("Winchester");
    expect(within(section).getByTestId("open-shift-office")).toHaveTextContent("Coordinated by Temecula Office");
    expect(section).not.toHaveTextContent(/Synthetic Client|\b92596\b/);
    fireEvent.click(within(section).getByRole("button", { name: "Request this shift" }));
    expect(await within(section).findByTestId("requested-badge", undefined, { timeout: 15000 })).toHaveTextContent("Requested");
    expect(calls.find((c) => c.path === `/v1/shifts/${SHIFT}/pickup`)!.body).toEqual({ organizationId: expect.any(String) });
    fireEvent.click(within(section).getByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(within(section).queryByTestId("requested-badge")).toBeNull(), { timeout: 15000 });
    expect(within(section).getByRole("button", { name: "Request this shift" })).toBeInTheDocument();
  }, 60000);
});

const req = (id: string, code: string, name: string, at: number, blockers: string[] = []) => ({ requestId: id, shiftId: SHIFT, requestedAt: later(at), startsAt: later(30), endsAt: later(32), minutes: 120, clientCode: "CL-1", serviceName: "Personal care",
  caregiverRecordId: `rec-${id}`, caregiverCode: code, caregiverName: name, blockers, eligible: blockers.length === 0, requestRank: 1 });
const OFFICE = ["shifts.manage", "visits.read", "visits.manage", "clients.names.read", "caregivers.manage", "assignments.manage", "authorizations.read"];

describe("office queue for one shift", () => {
  it("preselects the earliest ELIGIBLE request (a blocked earlier one is skipped); the office can pick another; confirming sends that request only", async () => {
    const list = [req("pr-1", "CG-1", "Blocked First", -3, ["Over the daily hour limit."]), req("pr-2", "CG-2", "Eligible Second", -2), req("pr-3", "CG-3", "Eligible Third", -1)];
    const { calls } = renderAws("/schedule", OFFICE, { "GET /v1/shift-pickups": () => json(200, { requests: list }), "GET /v1/shifts": () => json(200, { shifts: [] }),
      "POST /v1/shift-pickups/pr-3/confirm": () => json(200, { result: "covered" }), "POST /v1/shift-pickups/pr-2/confirm": () => json(200, { result: "covered" }) });
    const panel = await screen.findByTestId("pickup-requests", undefined, { timeout: 15000 });
    expect(within(panel).getAllByTestId("pickup-shift")).toHaveLength(1);                          // one card for the shift
    const radios = within(panel).getAllByTestId("pickup-choice") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);                              // in the order they asked: Blocked First, Eligible Second, Eligible Third
    expect(within(panel).getAllByTestId("pickup-earliest")).toHaveLength(1);
    expect(radios[1]!.closest("li")).toHaveTextContent("Eligible Second");
    expect(radios[1]!.closest("li")).toHaveTextContent("Earliest eligible request");
    expect(radios[0]!.closest("li")).toHaveTextContent("Would be refused now: Over the daily hour limit.");
    const asked = within(panel).getAllByTestId("pickup-asked").map((e) => e.textContent!);
    expect(asked.every((t) => /^Asked .+ PT$/.test(t))).toBe(true);                                // each request time is shown in Pacific time
    expect(within(panel).getByTestId("pickup-start")).toHaveTextContent(/^Shift starts .+ PT$/);
    fireEvent.click(radios[2]!);                                                                    // the office prefers the third
    fireEvent.click(within(panel).getByRole("button", { name: "Confirm assignment" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/shift-pickups/pr-3/confirm")).toBe(true), { timeout: 15000 });
    expect(calls.some((c) => c.path === "/v1/shift-pickups/pr-2/confirm")).toBe(false);
  }, 60000);
  it("with nobody eligible nothing is preselected and there is nothing to confirm until a person is chosen", async () => {
    renderAws("/schedule", OFFICE, { "GET /v1/shift-pickups": () => json(200, { requests: [req("pr-1", "CG-1", "Blocked One", -3, ["On a compliance hold."])] }), "GET /v1/shifts": () => json(200, { shifts: [] }) });
    const panel = await screen.findByTestId("pickup-requests", undefined, { timeout: 15000 });
    expect((within(panel).getByTestId("pickup-choice") as HTMLInputElement).checked).toBe(false);
    expect(within(panel).queryByTestId("pickup-earliest")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Confirm assignment" })).toBeNull();
    expect(panel).toHaveTextContent("Nobody asking can be confirmed right now");
  }, 40000);
  it("a caregiver never sees the queue (no permission): the panel is absent", async () => {
    renderAws("/schedule", [], { "GET /v1/shift-pickups": () => json(200, { requests: [req("pr-1", "CG-1", "X", -1)] }), "GET /v1/open-shifts": () => json(200, { shifts: [] }), "GET /v1/my-shifts": () => json(200, { shifts: [] }) });
    await screen.findByText(/Schedule|My shifts|shifts/i, undefined, { timeout: 15000 });
    expect(screen.queryByTestId("pickup-requests")).toBeNull();
  }, 40000);
});

const NC = { "GET /v1/notification-center": () => json(200, { notifications: { asOf: "x", unread: 0, items: [] } }),
  "GET /v1/notification-preferences": () => json(200, { preferences: { coverShift: { inApp: true, email: true }, coverOffice: { inApp: true, email: false }, canSeeOffice: true, emailAvailable: true } }),
  "GET /v1/cover-notification-settings": () => json(200, { settings: { enabled: true, emailEnabled: false, autoNotify: true, windowHours: 72, maxRecipients: 50, audience: "office", subjectTemplate: "Open shift in {city} | {date} | {time}" } }),
  "GET /v1/cover-notification-history": () => json(200, { history: [] }), "GET /v1/cover-office-audiences": () => json(200, { offices: [] }) };
const SMS = { enabled: false, provider: "mock", senderLabel: "SoCal Care", senderId: null, senderVerified: false, dailyLimit: 200, hourlyLimit: 60, perRecipientDaily: 3, quietStart: "21:00", quietEnd: "08:00",
  recruitmentDays: 14, escalationHours: 24, recruitOn: true, receiptOn: true, cancelOn: true, confirmOn: true, officeOn: true, sentToday: 0, liveSending: false };

describe("texting panels", () => {
  it("own opt-in: needs the number and the explicit yes; then shows only the last four digits and a stop button", async () => {
    let state: any = { available: true, status: "none", phoneLast4: null };
    const { calls } = renderAws("/notifications", [], { ...NC, "GET /v1/my-sms": () => json(200, { sms: state }),
      "POST /v1/my-sms": ({ body }: { body: Record<string, any> | null }) => { state = body?.consent ? { available: true, status: "opted_in", phoneLast4: "0123" } : { available: true, status: "opted_out", phoneLast4: "0123" }; return json(200, { sms: state }); } });
    const save = await screen.findByTestId("my-sms-save", undefined, { timeout: 15000 });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("my-sms-phone"), { target: { value: "(951) 555-0123" } });
    expect(save).toBeDisabled();                                                                     // the number alone is not consent
    fireEvent.click(screen.getByTestId("my-sms-agree"));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(await screen.findByTestId("my-sms-on", undefined, { timeout: 15000 })).toHaveTextContent("ending 0123");
    expect(calls.find((c) => c.path === "/v1/my-sms" && c.method === "POST")!.body).toEqual({ organizationId: expect.any(String), consent: true, phone: "(951) 555-0123", consentVersion: "v1" });
    fireEvent.click(screen.getByTestId("my-sms-off"));
    expect(await screen.findByTestId("my-sms-form", undefined, { timeout: 15000 })).toHaveTextContent("Texts are off for you");
  }, 60000);
  it("is absent where the switch is off (the routes do not exist) or the agency has not turned texting on", async () => {
    renderAws("/notifications", [], { ...NC });
    await screen.findByTestId("center-unread", undefined, { timeout: 15000 });
    expect(screen.queryByTestId("my-sms-form")).toBeNull();
    cleanup();
    renderAws("/notifications", [], { ...NC, "GET /v1/my-sms": () => json(200, { sms: { available: false, status: "none", phoneLast4: null } }) });
    await screen.findByTestId("center-unread", undefined, { timeout: 15000 });
    expect(screen.queryByTestId("my-sms-form")).toBeNull();
  }, 60000);
  it("owner: settings with the test-sender notice, limits and quiet hours; saves them; adds and removes an on-call number; the history shows last four digits only", async () => {
    let settings: any = { ...SMS }; let oncall: any[] = [];
    const { calls } = renderAws("/notifications", ["shifts.manage", "organization.update"], { ...NC,
      "GET /v1/my-sms": () => json(200, { sms: { available: false, status: "none", phoneLast4: null } }),
      "GET /v1/sms-settings": () => json(200, { settings }), "POST /v1/sms-settings": ({ body }: { body: Record<string, any> | null }) => { settings = { ...settings, ...body }; return json(200, { settings }); },
      "GET /v1/sms-oncall": () => json(200, { contacts: oncall }),
      "POST /v1/sms-oncall": ({ body }: { body: Record<string, any> | null }) => { oncall = body?.action === "add" ? [{ id: "oc-1", officeId: null, officeName: null, label: body.label, phoneLast4: "0199", active: true }] : []; return json(200, { result: {} }); },
      "GET /v1/sms-history": () => json(200, { messages: [{ id: "m1", purpose: "recruitment", recipientKind: "caregiver", status: "sent", reason: null, shiftId: SHIFT, round: 0, phoneLast4: "0101", createdAt: later(-1), provider: "mock" }] }) });
    expect(await screen.findByTestId("sms-mock-note", undefined, { timeout: 15000 })).toHaveTextContent("Nothing is sent to a phone yet");
    expect(screen.getByTestId("sms-history")).toHaveTextContent("Open-shift offer · caregiver ending 0101");
    expect(screen.getByTestId("sms-status")).toHaveTextContent("Sent (test sender)");
    const save = screen.getByTestId("sms-save");
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByTestId("sms-enabled"));
    fireEvent.change(screen.getByTestId("sms-dailyLimit"), { target: { value: "50" } });
    fireEvent.change(screen.getByTestId("sms-recruitmentDays"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("sms-quietStart"), { target: { value: "22:00" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/sms-settings" && c.method === "POST")).toBe(true), { timeout: 15000 });
    expect(calls.find((c) => c.path === "/v1/sms-settings" && c.method === "POST")!.body).toMatchObject({ enabled: true, dailyLimit: 50, recruitmentDays: 10, quietStart: "22:00", quietEnd: "08:00", provider: "mock", escalationHours: 24 });
    fireEvent.change(screen.getByTestId("oncall-label"), { target: { value: "On-call night" } });
    fireEvent.change(screen.getByTestId("oncall-phone"), { target: { value: "951-555-0199" } });
    fireEvent.click(screen.getByTestId("oncall-add"));
    expect(await screen.findByText(/On-call night · ends 0199/, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByText(/5550199/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(/On-call night/)).toBeNull(), { timeout: 15000 });
  }, 90000);
  it("a manager without the owner right sees the settings read-only", async () => {
    renderAws("/notifications", ["shifts.manage"], { ...NC, "GET /v1/my-sms": () => json(200, { sms: { available: false, status: "none", phoneLast4: null } }),
      "GET /v1/sms-settings": () => json(200, { settings: SMS }), "GET /v1/sms-oncall": () => json(200, { contacts: [] }), "GET /v1/sms-history": () => json(200, { messages: [] }) });
    await screen.findByTestId("sms-mock-note", undefined, { timeout: 15000 });
    expect(screen.queryByTestId("sms-save")).toBeNull();
    expect(screen.getByTestId("sms-dailyLimit")).toBeDisabled();
    expect(screen.queryByTestId("oncall-add")).toBeNull();
  }, 40000);
  it("office alert preferences appear for managers and save as their own category", async () => {
    const { calls } = renderAws("/notifications", ["shifts.manage"], { ...NC, "POST /v1/notification-preferences": () => json(200, { preferences: { coverShift: { inApp: true, email: true }, coverOffice: { inApp: true, email: true }, canSeeOffice: true, emailAvailable: true } }) });
    const box = await screen.findByTestId("office-pref-email", undefined, { timeout: 15000 });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/notification-preferences" && c.method === "POST")).toBe(true), { timeout: 15000 });
    expect(calls.find((c) => c.path === "/v1/notification-preferences" && c.method === "POST")!.body).toMatchObject({ category: "cover_office", inApp: true, email: true });
  }, 40000);
});

describe("alert link for a caregiver", () => {
  it("opening /schedule (the link in every open-shift alert and email) lands a caregiver on My Schedule with the request button", async () => {
    renderAws("/schedule", ["availability.manage_own"], {
      "GET /v1/open-shifts": () => json(200, { shifts: [{ shiftId: SHIFT, startsAt: later(30), endsAt: later(32), minutes: 120, clientCode: "CL-1", city: "Winchester", officeName: "Temecula Office", serviceName: "Respite", coverageState: "needs_coverage", myRequestStatus: null }] }),
      "GET /v1/my-shifts": () => json(200, { shifts: [] }),
    });
    expect(await screen.findByRole("button", { name: "Request this shift" }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByText("You do not have access to the schedule.")).toBeNull();
  }, 40000);
});

describe("alert opens the specific shift", () => {
  const link = (shiftId: string, extra: Record<string, unknown> = {}) => ({ "GET /v1/notification-center": () => json(200, { notifications: { asOf: new Date().toISOString(), unread: 0, items: [{ id: "n1", category: "cover_shift", title: "Open shift in Winchester", body: "x", link: "/schedule", shiftId, createdAt: later(-1), readAt: null, archivedAt: null, state: "unread" }, ...((extra.items as object[]) ?? [])] } }) });
  it("the Open link carries the shift, and the page shows it first with Request this shift", async () => {
    const other = { ...openShift, shiftId: "51515151-0000-4000-8000-000000000002", startsAt: later(10), endsAt: later(12) };
    renderAws(`/notifications`, ["availability.manage_own"], { ...link(SHIFT), "GET /v1/notification-preferences": () => json(200, { preferences: { coverShift: { inApp: true, email: false }, emailAvailable: false } }) });
    const open = await screen.findByRole("link", { name: "Open" }, { timeout: 15000 });
    expect(open).toHaveAttribute("href", `/my-shifts?shift=${SHIFT}`);
    cleanup();
    renderAws(`/my-shifts?shift=${SHIFT}`, ["availability.manage_own"], { "GET /v1/open-shifts": () => json(200, { shifts: [other, openShift] }), "GET /v1/my-shifts": () => json(200, { shifts: [] }) });
    const card = await screen.findByTestId("alert-shift", undefined, { timeout: 15000 });
    expect(card).toHaveTextContent("The shift from your alert");
    expect(within(card).getByRole("button", { name: "Request this shift" })).toBeInTheDocument();
    expect(card.closest("ul")!.firstElementChild).toBe(card);
  }, 60000);
  it("a shift that is no longer open says Filled; a cancelled one says Closed; no notice says no longer open; a confirmed caregiver sees that", async () => {
    const run = async (items: object[], mine: object[], expected: RegExp) => {
      renderAws(`/my-shifts?shift=${SHIFT}`, ["availability.manage_own"], { "GET /v1/open-shifts": () => json(200, { shifts: [] }), "GET /v1/my-shifts": () => json(200, { shifts: mine }), ...link(SHIFT, { items }) });
      expect(await screen.findByTestId("alert-shift-status", undefined, { timeout: 15000 })).toHaveTextContent(expected);
      cleanup();
    };
    const note = (title: string) => ({ id: title, category: "cover_shift", title, body: "", link: null, shiftId: SHIFT, createdAt: later(0), readAt: null, archivedAt: null, state: "unread" });
    await run([note("Filled | Winchester")], [], /^Filled\./);
    await run([note("Cancelled | Winchester")], [], /^Closed\./);
    await run([], [], /^No longer open/);
    await run([], [{ shiftId: SHIFT, startsAt: later(30), endsAt: later(32), clientCode: "CL-1", serviceName: "Respite", coverageState: "covered", canCallOut: true }], /confirmed for this shift/);
  }, 90000);
  it("/schedule?shift=… (an older link) forwards a caregiver to the same shift", async () => {
    renderAws(`/schedule?shift=${SHIFT}`, ["availability.manage_own"], { "GET /v1/open-shifts": () => json(200, { shifts: [openShift] }), "GET /v1/my-shifts": () => json(200, { shifts: [] }) });
    expect(await screen.findByTestId("alert-shift", undefined, { timeout: 15000 })).toBeInTheDocument();
  }, 40000);
});
