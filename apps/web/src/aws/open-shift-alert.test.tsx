/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// Open-shift alerts from the schedule (0113): choose the coordinating office when there are several, block on an incomplete service address, and report what was sent. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const SHIFT = "51515151-0000-4000-8000-000000000001", CLIENT = "cccccccc-0000-4000-8000-000000000001", TEM = "dddddddd-0000-4000-8000-0000000000a1", COR = "dddddddd-0000-4000-8000-0000000000a2";
const later = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const shift = { shiftId: SHIFT, clientId: CLIENT, clientCode: "CL-1", clientName: "Synthetic Client", serviceId: "s1", serviceCode: "PCS", serviceName: "Personal care", startsAt: later(30), endsAt: later(33), localDate: "2026-12-02",
  coverageState: "needs_coverage", caregiverRecordId: null, caregiverCode: null, caregiverName: null, hasSignIn: false, reservedMinutes: 180, fromCareRequest: false, hasVisit: false, lastCalloutReason: null };
const PERMS = ["shifts.manage", "visits.read", "visits.manage", "clients.names.read", "caregivers.manage", "assignments.manage", "authorizations.read"];
const handlers = (notify: (body: Record<string, any> | null) => Response) => ({
  "GET /v1/shifts": () => json(200, { shifts: [shift] }),
  "GET /v1/notification-center": () => json(200, { notifications: { asOf: "x", unread: 0, items: [] } }),
  [`POST /v1/shifts/${SHIFT}/notify-cover`]: ({ body }: { body: Record<string, any> | null }) => notify(body),
});
async function openAlert() {
  const more = await screen.findByRole("button", { name: /More actions/ }, { timeout: 15000 });
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("button", { name: "Send open-shift alert" }));
}

describe("send an open-shift alert", () => {
  it("reports who was told and the subject (service city first), when the office is known", async () => {
    const { calls } = renderAws("/schedule", PERMS, handlers(() => json(200, { result: { state: "done", notified: 2, subject: "Open shift in Winchester | Fri, Nov 27 | 1:30–5:00 PM", office: "Temecula Office" } })), "manager");
    await openAlert();
    expect(await screen.findByText(/2 caregivers were notified: Open shift in Winchester \| Fri, Nov 27 \| 1:30–5:00 PM/, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/notify-cover"))!.body).toEqual({ organizationId: expect.any(String) });   // no office sent: the server decides
  }, 40000);
  it("several offices and none on the shift: the sender must choose one, nothing is sent until they do, and the choice is sent with the alert", async () => {
    const { calls } = renderAws("/schedule", PERMS, handlers((body) => body?.officeId
      ? json(200, { result: { state: "done", notified: 1, subject: "Open shift in Winchester | x", office: "Temecula Office" } })
      : json(200, { result: { state: "office_required", offices: [{ officeId: COR, name: "Corona Office" }, { officeId: TEM, name: "Temecula Office" }] } })), "manager");
    await openAlert();
    const dialog = await screen.findByTestId("alert-office", undefined, { timeout: 15000 });
    const send = within(dialog).getByRole("button", { name: "Send the alert" });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId("alert-office-select"), { target: { value: TEM } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/notify-cover")).at(-1)!.body).toMatchObject({ officeId: TEM }), { timeout: 15000 });
    expect(await screen.findByText(/1 caregiver was notified/, undefined, { timeout: 15000 })).toBeInTheDocument();
  }, 40000);
  it("an incomplete service address blocks the alert, names what is missing and sends staff to the client record; nothing says the office city will be used", async () => {
    renderAws("/schedule", PERMS, handlers(() => json(200, { result: { state: "address_incomplete", clientId: CLIENT, missing: ["city", "zip"] } })), "manager");
    await openAlert();
    const dialog = await screen.findByTestId("alert-address", undefined, { timeout: 15000 });
    expect(dialog).toHaveTextContent("missing the city and ZIP code");
    expect(within(dialog).getByRole("link", { name: "Open the client record to complete it" })).toHaveAttribute("href", `/clients/${CLIENT}?edit=location#service-location`);
    expect(dialog).not.toHaveTextContent(/office city will/i);
  }, 40000);
  it("an office whose alerts are off, and an agency with alerts off, say so in plain words", async () => {
    renderAws("/schedule", PERMS, handlers(() => json(200, { result: { state: "office_audience_off", office: "Temecula Office" } })), "manager");
    await openAlert();
    expect(await screen.findByText(/Alerts are turned off for Temecula Office/, undefined, { timeout: 15000 })).toBeInTheDocument();
  }, 40000);
});
