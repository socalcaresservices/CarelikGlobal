import { describe, expect, it } from "vitest";
import { orderChainRows, orderCorrectionRows, orderMonthlyServiceRows } from "@carelik/auth/export-order";
import { buildReportCsv } from "../src/exports";

// A stand-in database: each report function returns its rows in a scrambled order, as the server may.
function fakeDb(byFunction: Record<string, Array<Record<string, unknown>>>) {
  return {
    query: async (sql: string) => {
      const name = Object.keys(byFunction).find((k) => sql.includes(k));
      return { rows: name ? byFunction[name]! : [] };
    },
  } as never;
}
const parse = (csv: string) => csv.split("\r\n").map((l) => l.split(","));
const ORG = "11111111-1111-4111-8111-111111111111";

describe("server-made exports follow the screen's documented row order", () => {
  it("monthly chain: file rows come out in the order orderChainRows gives the screen", async () => {
    const raw = [
      { client_code: "C-2", service_code: "RSP", service_name: "Respite", period_start: "2026-01-01", period_end: "2026-12-31" },
      { client_code: "C-10", service_code: "ATC", service_name: "Attendant", period_start: "2026-01-01", period_end: "2026-12-31" },
      { client_code: "C-2", service_code: "ATC", service_name: "Attendant", period_start: "2026-01-01", period_end: "2026-12-31" },
    ];
    const built = await buildReportCsv(fakeDb({ get_monthly_chain_report: raw }), ORG, "monthly_chain", { monthStart: "2026-10-01" } as never);
    const screen = orderChainRows(raw.map((r) => ({ clientCode: r.client_code, serviceCode: r.service_code, serviceName: r.service_name })));
    const fileRows = parse(built.csv).slice(1, 1 + raw.length).map((r) => [r[0], r[1]].map((c) => (c ?? "").replace(/"/g, "")));
    expect(fileRows).toEqual(screen.map((r) => [r.clientCode, r.serviceCode]));
    expect(fileRows).toEqual([["C-2", "ATC"], ["C-2", "RSP"], ["C-10", "ATC"]]);
  });

  it("client service calendar: service code, name, authorization period oldest first", async () => {
    const row = (code: string, start: string) => ({ client_id: "c1", client_code: "C-1", service_code: code, service_name: code, authorization_period_start: start, authorization_period_end: "2027-01-01" });
    const raw = [row("RSP", "2026-07-01"), row("ATC", "2026-07-01"), row("RSP", "2026-01-01")];
    const built = await buildReportCsv(fakeDb({ list_monthly_service_summary: raw }), ORG, "client_service_calendar", { monthStart: "2026-10-01", clientId: "c1" } as never);
    const rows = parse(built.csv).slice(1, 4).map((r) => r.map((c) => c.replace(/"/g, "")));
    const screen = orderMonthlyServiceRows(raw.map((r) => ({ serviceCode: r.service_code, serviceName: r.service_name, authorizationPeriodStart: r.authorization_period_start, authorizationPeriodEnd: r.authorization_period_end })));
    // Columns: client code, "CODE name", period start, period end (no client names without the directory).
    expect(rows.map((r) => `${r[1]}|${r[2]}`)).toEqual(screen.map((r) => `${r.serviceCode} ${r.serviceName}|${r.authorizationPeriodStart}`));
    expect(rows.map((r) => r[2])).toEqual(["2026-07-01", "2026-01-01", "2026-07-01"]);
  });

  it("correction history: newest correction first, then visit ref", async () => {
    const row = (visit: string, at: string) => ({ visit_number: visit, client_id: "c1", client_code: "C-1", service_code: "RSP", service_name: "Respite", service_date: "2026-10-01", caregiver_name: "Sam", created_at: at, before_snapshot: null, after_snapshot: null });
    const raw = [row("V-2", "2026-10-02T10:00:00Z"), row("V-9", "2026-10-05T10:00:00Z"), row("V-1", "2026-10-02T10:00:00Z")];
    const built = await buildReportCsv(fakeDb({ list_correction_history_report: raw }), ORG, "correction_history" as never, { dateFrom: "2026-10-01", dateTo: "2026-10-31" } as never);
    const screen = orderCorrectionRows(raw.map((r) => ({ createdAt: r.created_at, visitNumber: r.visit_number })));
    const fileVisits = parse(built.csv).slice(1, 4).map((r) => (r[0] ?? "").replace(/"/g, ""));
    expect(fileVisits).toEqual(screen.map((r) => r.visitNumber));
    expect(fileVisits).toEqual(["V-9", "V-1", "V-2"]);
  });
});
