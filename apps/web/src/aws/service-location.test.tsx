/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles: request bodies are free-form JSON */
// The client profile's SERVICE LOCATION (0118): service address (city and ZIP, entered once), county and coordinating office in one section with one edit flow; Details no longer carries a city.
// SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const CL = "cccccccc-0000-4000-8000-000000000001", TEM = "dddddddd-0000-4000-8000-0000000000a1", MUR = "dddddddd-0000-4000-8000-0000000000a2";
const PERMS = ["clients.manage", "clients.names.manage", "clients.names.read", "visits.read", "authorizations.read"];
const client = { clientId: CL, clientCode: "CL-TEST000001", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Clientone", city: null as string | null, clientTypeId: null, clientTypeName: null, duplicateName: false, createdAt: "2026-11-01T00:00:00Z" };
const loc = (over: Record<string, any> = {}) => ({ city: "Winchester", zip: "92596", state: "CA", county: "Riverside", office: { officeId: TEM, name: "Temecula" }, otherOffices: [], missing: [], complete: true, countySuggestion: null, ...over });
const offices = { "GET /v1/offices": () => json(200, { offices: [{ officeId: TEM, name: "Temecula", isActive: true, county: null, clientCount: 1, caregiverCount: 0 }, { officeId: MUR, name: "Murrieta", isActive: true, county: null, clientCount: 0, caregiverCount: 0 }] }) };
const base = (l: () => any) => ({ "GET /v1/clients": () => json(200, { clients: [client] }), [`GET /v1/clients/${CL}/service-location`]: () => json(200, { location: l() }), ...offices });

describe("client profile: service location", () => {
  it("shows Winchester, CA 92596 · Riverside County · Temecula office in one section; Details has no separate city and never says 'No city'", async () => {
    renderAws(`/clients/${CL}`, PERMS, base(() => loc()), "manager");
    const card = await screen.findByTestId("service-location", undefined, { timeout: 15000 });
    expect(within(card).getByTestId("location-summary")).toHaveTextContent("Winchester, CA 92596 · Riverside County · Temecula office");
    expect(within(card).getByText("Where the caregiver goes. Open-shift matching uses this city.")).toBeInTheDocument();
    expect(within(card).getByText("Used for county reports and filters.")).toBeInTheDocument();
    expect(within(card).getByText(/Manages this client's shifts and coverage requests/)).toBeInTheDocument();
    const details = await screen.findByTestId("details-readonly");
    expect(details).not.toHaveTextContent(/No city/);                                              // the Details city is gone (it was empty here while the service address said Winchester)
    expect(within(details).queryByText("City")).toBeNull();
    expect(screen.queryByText("Assigned Offices")).toBeNull();                                      // the old stand-alone office control is inside the section's disclosure only
  }, 40000);
  it("one edit flow: city, ZIP, county (suggested, correctable) and the coordinating office are saved together; the office is never preselected for a client without one", async () => {
    let current: any = loc({ county: null, office: null, countySuggestion: { county: "Riverside", basis: "agency_clients" } });
    const { calls } = renderAws(`/clients/${CL}`, PERMS, { ...base(() => current), [`POST /v1/clients/${CL}/service-location`]: ({ body }: { body: any }) => { current = loc({ county: "Riverside", office: { officeId: body.officeId, name: "Murrieta" } }); return json(200, { location: current }); } }, "manager");
    const card = await screen.findByTestId("service-location", undefined, { timeout: 15000 });
    expect(card).toHaveTextContent("Winchester, CA 92596 · County not set · No coordinating office");
    fireEvent.click(within(card).getByTestId("location-edit"));
    const form = await screen.findByTestId("location-form");
    expect(within(form).getByLabelText("City of the service address")).toHaveValue("Winchester");
    expect(within(form).getByLabelText("Coordinating office")).toHaveValue("");                      // explicit: nothing chosen for the person
    expect(within(form).getByTestId("county-suggestion")).toHaveTextContent("Suggested: Riverside County (from other clients with this ZIP)");
    fireEvent.click(within(form).getByRole("button", { name: "Use this" }));
    expect(within(form).getByLabelText("Service county")).toHaveValue("Riverside");
    expect(within(form).queryByTestId("county-suggestion")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Coordinating office"), { target: { value: MUR } });
    fireEvent.click(within(form).getByRole("button", { name: "Save service location" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/service-location"))?.body).toEqual({ organizationId: expect.any(String), city: "Winchester", zip: "92596", county: "Riverside", officeId: MUR }), { timeout: 15000 });
    expect(await screen.findByText(/Saved\. The change is in the client's history\./, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByTestId("location-summary")).toHaveTextContent("Winchester, CA 92596 · Riverside County · Murrieta office");
  }, 60000);
  it("the county can be corrected by hand; the saved county is sent as chosen, a blank clears it", async () => {
    const { calls } = renderAws(`/clients/${CL}`, PERMS, { ...base(() => loc({ countySuggestion: null })), [`POST /v1/clients/${CL}/service-location`]: () => json(200, { location: loc({ county: null }) }) }, "manager");
    fireEvent.click(await screen.findByTestId("location-edit", undefined, { timeout: 15000 }));
    const form = await screen.findByTestId("location-form");
    fireEvent.change(within(form).getByLabelText("Service county"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save service location" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/service-location"))?.body).toMatchObject({ county: null, officeId: TEM }), { timeout: 15000 });
  }, 40000);
  it("an incomplete service address says exactly what is missing and the link opens the edit form directly", async () => {
    renderAws(`/clients/${CL}?edit=location`, PERMS, base(() => loc({ zip: null, missing: ["zip"], complete: false })), "manager");
    const form = await screen.findByTestId("location-form", undefined, { timeout: 15000 });         // opened straight from the link
    expect(within(form).getByLabelText("ZIP code")).toHaveValue("");
    expect(within(form).getByLabelText("City of the service address")).toHaveFocus();
    fireEvent.click(within(form).getByRole("button", { name: "Save service location" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Enter the 5-digit ZIP code of the service address.");
  }, 40000);
  it("saving from the link closes the form and shows the new summary (the link's ?edit=location does not re-open it)", async () => {
    let current: any = loc({ zip: null, missing: ["zip"], complete: false });
    renderAws(`/clients/${CL}?edit=location`, PERMS, { ...base(() => current), [`POST /v1/clients/${CL}/service-location`]: () => { current = loc(); return json(200, { location: current }); } }, "manager");
    const form = await screen.findByTestId("location-form", undefined, { timeout: 15000 });
    fireEvent.change(within(form).getByLabelText("ZIP code"), { target: { value: "92596" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save service location" }));
    expect(await screen.findByTestId("location-summary", undefined, { timeout: 15000 })).toHaveTextContent("Winchester, CA 92596 · Riverside County · Temecula office");
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("location-form")).toBeNull();
  }, 40000);
  it("without the link the incomplete state is stated plainly with a button to the form", async () => {
    renderAws(`/clients/${CL}`, PERMS, base(() => loc({ city: null, zip: null, missing: ["city", "zip"], complete: false, county: null, office: null })), "manager");
    const card = await screen.findByTestId("service-location", undefined, { timeout: 15000 });
    expect(within(card).getByTestId("location-missing")).toHaveTextContent("The service address is missing the city and ZIP code.");
    expect(within(card).getByTestId("location-summary")).toHaveTextContent("No service address · County not set · No coordinating office");
    fireEvent.click(within(card).getByRole("button", { name: "Complete the service address" }));
    expect(await screen.findByTestId("location-form")).toBeInTheDocument();
  }, 40000);
  it("where the switch is off the section is absent and the old Details city field is unchanged", async () => {
    renderAws(`/clients/${CL}`, PERMS, { "GET /v1/clients": () => json(200, { clients: [{ ...client, city: "Winchester" }] }) }, "manager");
    const details = await screen.findByTestId("details-readonly", undefined, { timeout: 15000 });
    expect(within(details).getByText("City")).toBeInTheDocument();
    expect(screen.queryByTestId("service-location")).toBeNull();
  }, 40000);
});
