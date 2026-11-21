import { describe, expect, it } from "vitest";
import { orderBillingSubmissionItems, orderChainRows, orderCorrectionRows, orderMonthlyServiceRows } from "./export-order";

describe("documented default export order", () => {
  it("monthly service rows: service code, service name, authorization period oldest first", () => {
    const r = (c: string, n: string, s: string, e: string, tag: string) => ({ serviceCode: c, serviceName: n, authorizationPeriodStart: s, authorizationPeriodEnd: e, tag });
    const out = orderMonthlyServiceRows([r("RSP", "Respite", "2026-07-01", "2026-12-31", "b"), r("ATC", "Attendant", "2026-07-01", "2026-12-31", "c"), r("RSP", "Respite", "2026-01-01", "2026-06-30", "a"), r("ATC", "Attendant", "2026-01-01", "2026-06-30", "d")]);
    expect(out.map((x) => x.tag)).toEqual(["d", "c", "a", "b"]);
  });

  it("monthly chain rows: client code (natural order), service, period", () => {
    const r = (cc: string, sc: string, tag: string) => ({ clientCode: cc, serviceCode: sc, serviceName: sc, periodStart: "2026-01-01", periodEnd: "2026-12-31", tag });
    expect(orderChainRows([r("C-10", "A", "x"), r("C-2", "B", "y"), r("C-2", "A", "z")]).map((x) => x.tag)).toEqual(["z", "y", "x"]);
  });

  it("billing submission items: client, service, service date oldest first; empty last", () => {
    const r = (c: string | null, s: string, d: string, tag: string) => ({ client_name: c, service_name: s, service_date: d, tag });
    const out = orderBillingSubmissionItems([r("Zed", "Respite", "2026-03-02", "e"), r("Amy", "Respite", "2026-03-09", "b"), r(null, "Respite", "2026-03-01", "f"), r("Amy", "Respite", "2026-03-02", "a"), r("amy", "Attendant", "2026-03-30", "c")]);
    expect(out.map((x) => x.tag)).toEqual(["c", "a", "b", "e", "f"]);
  });

  it("correction rows: corrected-on newest first, then visit ref; does not change its input", () => {
    const r = (createdAt: string, visitNumber: string, tag: string) => ({ createdAt, visitNumber, tag });
    const input = [r("2026-05-01T10:00:00Z", "V-2", "b"), r("2026-05-03T10:00:00Z", "V-9", "a"), r("2026-05-01T10:00:00Z", "V-1", "c")];
    const copy = [...input];
    expect(orderCorrectionRows(input).map((x) => x.tag)).toEqual(["a", "c", "b"]);
    expect(input).toEqual(copy);
    expect(orderCorrectionRows([])).toEqual([]);
  });

  it("ties keep input order", () => {
    const rows = [{ serviceCode: "A", serviceName: "x", tag: "1" }, { serviceCode: "A", serviceName: "x", tag: "2" }];
    expect(orderMonthlyServiceRows(rows).map((x) => x.tag)).toEqual(["1", "2"]);
  });
});
