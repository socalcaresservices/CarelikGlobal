// R11: the import drawer. Check first (nothing created), then confirm; plain messages for refusals; nothing is sent until a file is chosen. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["staff.read", "staff.manage", "visits.read", "clients.names.read"];
const base = (imp: (body: Record<string, unknown> | undefined) => Response) => ({
  "GET /v1/staff": () => json(200, { staff: [] }),
  "GET /v1/staff-types": () => json(200, { staffTypes: [] }),
  "POST /v1/imports/people": ({ body }: { body: Record<string, unknown> | null }) => imp(body ?? undefined),
});
const file = (name = "people.csv") => new File(["first_name,last_name\nA,B\n"], name, { type: "text/csv" });
const open = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Import from a file" }, { timeout: 15000 }));
  return screen.findByRole("dialog");
};
const choose = (dialog: HTMLElement, f: File) => fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [f] } });
const PREVIEW = { import: { mode: "preview", counts: { total: 3, new: 1, duplicate: 1, invalid: 1 }, created: 0, rows: [{ row: 3, status: "duplicate", message: "A caregiver with this name already exists or is repeated in the file" }, { row: 4, status: "invalid", message: "First name and last name are required" }] }, ignoredColumns: ["Notes"] };

describe("import drawer", () => {
  it("sends nothing until a file is chosen and checked; the check shows counts and row messages and offers no import while rows are invalid", async () => {
    const { calls } = renderAws("/staff", PERMS, base(() => json(200, PREVIEW)), "organization_owner");
    const dialog = await open();
    expect(within(dialog).getByRole("button", { name: "Check the file" })).toBeDisabled();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    choose(dialog, file());
    fireEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));
    const result = await within(dialog).findByTestId("import-result", undefined, { timeout: 15000 });
    expect(result).toHaveTextContent("1 new · 1 already exist (skipped) · 1 need fixing");
    expect(result).toHaveTextContent("Row 4: First name and last name are required");
    expect(result).toHaveTextContent("Columns not used: Notes");
    expect(within(dialog).queryByRole("button", { name: /^Import \d/ })).toBeNull();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/v1/imports/people");
    expect(post.body).toMatchObject({ fileName: "people.csv", confirm: false });
    expect(typeof post.body?.contentBase64).toBe("string");
  }, 30000);

  it("a clean file: Import N sends confirm=true once and reports that no invitation was sent", async () => {
    const clean = { import: { mode: "preview", counts: { total: 2, new: 2, duplicate: 0, invalid: 0 }, created: 0, rows: [] }, ignoredColumns: [] };
    const applied = { import: { mode: "applied", counts: { total: 2, new: 2, duplicate: 0, invalid: 0 }, created: 2, rows: [] }, ignoredColumns: [] };
    const { calls } = renderAws("/staff", PERMS, base((body) => json(200, body?.confirm ? applied : clean)), "organization_owner");
    const dialog = await open();
    choose(dialog, file());
    fireEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import 2 new" }, { timeout: 15000 }));
    await waitFor(() => expect(within(dialog).getByTestId("import-result")).toHaveTextContent("Imported 2."), { timeout: 15000 });
    expect(within(dialog).getByTestId("import-result")).toHaveTextContent("No invitations were sent.");
    expect(calls.filter((c) => c.method === "POST" && c.body?.confirm === true)).toHaveLength(1);
  }, 30000);

  it("a refused file shows the server's plain message; a missing route says it is not available yet", async () => {
    renderAws("/staff", PERMS, base(() => json(422, { error: { code: "invalid_file", message: "The header row is missing: last name. Use the template." } })), "organization_owner");
    const dialog = await open();
    choose(dialog, file());
    fireEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));
    expect(await within(dialog).findByRole("alert", undefined, { timeout: 15000 })).toHaveTextContent("The header row is missing: last name. Use the template.");
    cleanup();
    renderAws("/staff", PERMS, base(() => json(404, { error: { code: "not_found", message: "Not found" } })), "organization_owner");
    const d2 = await open();
    choose(d2, file());
    fireEvent.click(within(d2).getByRole("button", { name: "Check the file" }));
    expect(await within(d2).findByRole("alert", undefined, { timeout: 15000 })).toHaveTextContent("Import is not available in this environment yet.");
  }, 40000);

  it("the same file already imported says so and creates nothing", async () => {
    renderAws("/staff", PERMS, base(() => json(200, { import: { mode: "already_imported", counts: { total: 2, new: 0, duplicate: 0, invalid: 0 }, created: 2, importedAt: "2026-11-09T10:00:00Z", rows: [] }, ignoredColumns: [] })), "organization_owner");
    const dialog = await open();
    choose(dialog, file());
    fireEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));
    expect(await within(dialog).findByTestId("import-result", undefined, { timeout: 15000 })).toHaveTextContent("already imported");
    expect(within(dialog).queryByRole("button", { name: /^Import \d/ })).toBeNull();
  }, 30000);

  it("is not offered to someone who cannot manage staff", async () => {
    renderAws("/staff", ["staff.read", "visits.read"], base(() => json(200, PREVIEW)), "manager");
    await screen.findByRole("heading", { name: "Staff" }, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Import from a file" })).toBeNull();
  }, 30000);
});
