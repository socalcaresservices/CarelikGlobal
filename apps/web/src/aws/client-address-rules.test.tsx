// With open-shift alerts on, a client's service address needs a city AND a ZIP code (UI side; the API enforces the same). SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["clients.manage", "clients.names.manage", "clients.names.read", "visits.read", "authorizations.read"];
const on = { "GET /v1/notification-center": () => json(200, { notifications: { asOf: "x", unread: 0, items: [] } }) };
const created = { "POST /v1/clients": () => json(201, { client: { clientId: "cccccccc-0000-4000-8000-0000000000c1", clientCode: "CL-TEST000001" } }) };

describe("client service address rules (alerts on)", () => {
  it("adding a client needs the service city and a 5-digit ZIP; both are sent; the labels say what they are for", async () => {
    const { calls } = renderAws("/clients", PERMS, { ...on, ...created }, "manager");
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }, { timeout: 15000 }));
    expect(await screen.findByLabelText("City of the service address", undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByLabelText("ZIP code of the service address")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Clientone" } });
    const submit = () => fireEvent.click(screen.getAllByRole("button", { name: "Add client" }).at(-1)!);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the city of the service address.");
    fireEvent.change(screen.getByLabelText("City of the service address"), { target: { value: "Winchester" } });
    submit();
    expect(await screen.findByText("Enter the 5-digit ZIP code of the service address.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ZIP code of the service address"), { target: { value: "92596" } });
    submit();
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/v1/clients")?.body).toMatchObject({ city: "Winchester", serviceZip: "92596" }), { timeout: 15000 });
  }, 40000);
  it("with alerts off nothing changes: the city stays optional and there is no ZIP field", async () => {
    renderAws("/clients", PERMS, created, "manager");
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }, { timeout: 15000 }));
    expect(await screen.findByLabelText("City (optional)", undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByLabelText("ZIP code of the service address")).toBeNull();
  }, 40000);
  it("editing a client's details also needs the service city and ZIP; the saved ZIP is filled in; both are sent on save", async () => {
    const CL = "cccccccc-0000-4000-8000-000000000001";
    const client = { clientId: CL, clientCode: "CL-TEST000001", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Clientone", city: "Winchester", clientTypeId: null, clientTypeName: null, duplicateName: false, createdAt: "2026-11-01T00:00:00Z" };
    const { calls } = renderAws(`/clients/${CL}`, PERMS, {
      ...on, "GET /v1/clients": () => json(200, { clients: [client] }), [`GET /v1/clients/${CL}/zip`]: () => json(200, { location: { zip: "92596" } }),
      [`POST /v1/clients/${CL}/details`]: () => json(200, { ok: true }),
    }, "manager");
    const edit = await screen.findByRole("button", { name: /Edit details|Edit/ }, { timeout: 15000 }).catch(() => null);
    if (edit) fireEvent.click(edit);
    const zip = await screen.findByLabelText("ZIP code of the service address", undefined, { timeout: 15000 });
    await waitFor(() => expect(zip).toHaveValue("92596"));
    fireEvent.change(zip, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Enter the 5-digit ZIP code of the service address.")).toBeInTheDocument();
    fireEvent.change(zip, { target: { value: "92596" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === `/v1/clients/${CL}/details`)?.body).toMatchObject({ city: "Winchester", serviceZip: "92596" }), { timeout: 15000 });
  }, 40000);
});

