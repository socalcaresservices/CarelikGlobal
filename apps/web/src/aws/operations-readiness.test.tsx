// Operations readiness: four sections from one server call, sortable tables, named gaps instead of zeros, the switch-off state. SYNTHETIC data only.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["visits.read", "shifts.manage", "documents.read", "readiness.read"];
const READY = {
  asOf: "2026-12-01T18:00:00Z", unavailable: [],
  expiring: [
    { clientId: "c1", clientCode: "CL-AAAA0001", serviceName: "Respite", endsOn: "2026-12-20", daysLeft: 19, availableMinutes: 600 },
    { clientId: "c2", clientCode: "CL-AAAA0002", serviceName: "Personal care", endsOn: "2026-12-05", daysLeft: 4, availableMinutes: 1200 },
  ],
  overview: {
    urgentWindowHours: 48, pickups: { count: 2 },
    upcoming: { count: 2, shifts: [
      { shiftId: "s1", startsAt: "2026-12-02T17:00:00Z", endsAt: "2026-12-02T19:00:00Z", reason: "open", clientCode: "CL-AAAA0001", clientName: null, serviceName: "Respite" },
      { shiftId: "s2", startsAt: "2026-12-02T15:00:00Z", endsAt: "2026-12-02T17:00:00Z", reason: "called_out", clientCode: "CL-AAAA0002", clientName: null, serviceName: "Personal care" },
    ] },
    documents: { overdue: 3, dueSoon: 5, awaitingReview: 1, reviewOverdue: 0, rejected: 2 },
  },
  compliance: { enforcementActive: false, readyOrActive: 10, wouldBeHeld: 2, pastDeadline: 1, hireDateMissing: 0, strictDocumentProblem: 4, openHolds: 0 },
};
const rowsOf = (t: HTMLElement) => within(t).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");

describe("operations readiness", () => {
  it("shows the four sections with the server's figures, links to the pages that own them, and the time it is as of", async () => {
    renderAws("/operations-readiness", PERMS, { "GET /v1/operations-readiness": () => json(200, { readiness: READY }) }, "organization_owner");
    expect(await screen.findByRole("heading", { name: "Authorizations ending (next 30 days)" }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByTestId("ops-asof")).toHaveTextContent("As of");
    const docs = screen.getByRole("region", { name: "Documents" });
    expect(docs).toHaveTextContent("Overdue"); expect(within(docs).getByText("3")).toBeInTheDocument();
    expect(within(docs).getByRole("link", { name: "Open Documents" })).toHaveAttribute("href", "/documents");
    const comp = screen.getByRole("region", { name: "Compliance alerts" });
    expect(comp).toHaveTextContent("report-only"); expect(within(comp).getByRole("link", { name: "Open compliance holds" })).toHaveAttribute("href", "/compliance");
    expect(screen.getByRole("region", { name: "Open shifts" })).toHaveTextContent("2 caregiver requests for open shifts waiting");
  }, 30000);
  it("sorts the ending authorizations (days left as numbers) and the open shifts (when, as dates)", async () => {
    renderAws("/operations-readiness", PERMS, { "GET /v1/operations-readiness": () => json(200, { readiness: READY }) }, "organization_owner");
    const exp = await screen.findByRole("table", { name: "Authorizations ending" }, { timeout: 15000 });
    expect(rowsOf(exp)[0]).toContain("CL-AAAA0001");            // the server's order first
    fireEvent.click(within(exp).getByRole("button", { name: /Days left/ }));
    expect(rowsOf(exp)[0]).toContain("CL-AAAA0002");            // 4 days before 19
    const shifts = screen.getByRole("table", { name: "Open shifts" });
    fireEvent.click(within(shifts).getByRole("button", { name: /When/ }));
    expect(rowsOf(shifts)[0]).toContain("Respite");              // dates start newest first
    fireEvent.click(within(shifts).getByRole("button", { name: /When/ }));
    expect(rowsOf(shifts)[0]).toContain("Personal care");
  }, 30000);
  it("a part the server could not give is named, never shown as zero or as none", async () => {
    renderAws("/operations-readiness", ["visits.read"], { "GET /v1/operations-readiness": () => json(200, { readiness: { ...READY, expiring: null, compliance: null, unavailable: ["expiring", "compliance"] } }) }, "manager");
    expect(await screen.findByTestId("ops-missing-expiring", undefined, { timeout: 15000 })).toHaveTextContent("It is not shown as none");
    expect(screen.getByTestId("ops-missing-compliance")).toBeInTheDocument();
    expect(screen.queryByText("No authorization with available hours ends in the next 30 days.")).toBeNull();
    expect(screen.queryByTestId("ops-missing-documents")).toBeNull();
  }, 30000);
  it("a failed load is an error with Retry, not zeros; the empty cases say so plainly", async () => {
    renderAws("/operations-readiness", PERMS, { "GET /v1/operations-readiness": () => json(500, { error: { code: "internal_error", message: "Something went wrong." } }) }, "organization_owner");
    expect(await screen.findByText(/could not be loaded. It is not shown as zero./, undefined, { timeout: 15000 })).toBeInTheDocument();
    cleanup();
    renderAws("/operations-readiness", PERMS, { "GET /v1/operations-readiness": () => json(200, { readiness: { ...READY, expiring: [], overview: { ...READY.overview, upcoming: { count: 0, shifts: [] } } } }) }, "organization_owner");
    expect(await screen.findByText("No authorization with available hours ends in the next 30 days.", undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText("Every shift in this window has a caregiver who may work it.")).toBeInTheDocument();
  }, 40000);
  it("the sidebar tab appears only where the switch is on", async () => {
    renderAws("/", PERMS, { "GET /v1/operations-readiness": () => json(200, { readiness: READY }) }, "organization_owner");
    expect(await screen.findByRole("link", { name: "Operations readiness" }, { timeout: 15000 })).toHaveAttribute("href", "/operations-readiness");
    cleanup();
    renderAws("/", PERMS, {}, "organization_owner");   // route absent
    await screen.findAllByText(/Dashboard/, undefined, { timeout: 15000 });
    expect(screen.queryByRole("link", { name: "Operations readiness" })).toBeNull();
  }, 40000);
});
