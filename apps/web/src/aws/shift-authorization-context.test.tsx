// The shift's authorization context (service and Hours left from the server's monthly summary) stays visible while a shift is
// scheduled, and the client page links to Shift requests. SYNTHETIC data only.
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { json, renderAws } from "./test-support";

const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SERVICE = "bbbbbbbb-0000-4000-8000-000000000001";
const PERMS = ["shifts.manage", "visits.read", "clients.names.read", "authorizations.read", "care_requests.read"];
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const handlers = (hoursLeftMinutes: number) => ({
  "GET /v1/clients": () => json(200, { clients: [{ clientId: CLIENT, clientCode: "C-104", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: "Riverside", clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] }),
  "GET /v1/services": () => json(200, { services: [{ serviceId: SERVICE, code: "862", name: "Respite Care", isActive: true }] }),
  [`GET /v1/clients/${CLIENT}/authorizations`]: () => json(200, { authorizations: [{ authorizationId: "a1", lineageId: "l1", versionNumber: 1, isCurrent: true, serviceId: SERVICE, serviceCode: "862", serviceName: "Respite Care", payer: "Synthetic Payer", authorizationNumber: null, monthlyAuthorizedMinutes: 6000, periodStart: "2020-01-01", periodEnd: "2099-12-31", receivedDate: null, sourceReference: null, changeReason: null, createdAt: "2020-01-01T00:00:00Z", createdByName: null, hourlyRateCents: null }] }),
  "GET /v1/reports/monthly-service-summary": () => json(200, { services: [{ serviceId: SERVICE, serviceName: "Respite Care", authorizationLineageId: "l1", authorizedMinutes: 6000, workedMinutes: 0, billableMinutes: 0, remainingMinutes: hoursLeftMinutes, hoursLeftMinutes, reviewMinutes: 0 }] }),
});

describe("authorization context in scheduling", () => {
  it("Add shift shows the service and the server's Hours left for the shift's month before the caregiver and eligibility steps", async () => {
    const { calls } = renderAws(`/schedule?add=1&client=${CLIENT}`, PERMS, handlers(4530));
    const line = await screen.findByTestId("shift-authorization");
    expect(line).toHaveTextContent("Respite Care");
    expect(line).toHaveTextContent("Hours left 75 hr 30 min");
    // The figure is the server's: the request is the monthly summary for the client, not a local calculation.
    expect(calls.some((c) => c.path === "/v1/reports/monthly-service-summary" && c.query.get("clientId") === CLIENT)).toBe(true);
  });

  it("an over-limit authorization is named, not shown as zero", async () => {
    renderAws(`/schedule?add=1&client=${CLIENT}`, PERMS, handlers(-90));
    expect(await screen.findByTestId("shift-authorization")).toHaveTextContent("Over limit 1 hr 30 min");
  });

  it("without visits.read there is no figure and no request for it", async () => {
    const { calls } = renderAws(`/schedule?add=1&client=${CLIENT}`, ["shifts.manage", "clients.names.read", "authorizations.read"], handlers(4530));
    await screen.findByRole("heading", { name: /Sched/ });
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/authorizations"))).toBe(true));
    expect(screen.queryByTestId("shift-authorization")).toBeNull();
    expect(calls.some((c) => c.path === "/v1/reports/monthly-service-summary")).toBe(false);
  });
});

describe("client context", () => {
  it("the client page links to Shift requests (new address) for someone who may read care requests", async () => {
    renderAws(`/clients/${CLIENT}`, PERMS, handlers(4530));
    const link = await screen.findByRole("link", { name: "Care requests" });
    expect(link.getAttribute("href")).toBe("/schedule/shift-requests");
  });
});
