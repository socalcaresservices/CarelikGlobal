import { describe, expect, it } from "vitest";
import { sortMonthlyServiceRows } from "@/aws/ui/monthly-service-order";

const row = (serviceCode: string, serviceName: string, start: string, end: string, tag: string) => ({
  serviceCode, serviceName, authorizationPeriodStart: start, authorizationPeriodEnd: end, tag,
});

describe("calendar CSV row order", () => {
  it("orders by service code, service name, then authorization period oldest first", () => {
    const sorted = sortMonthlyServiceRows([
      row("RSP", "Respite", "2026-07-01", "2026-12-31", "b"),
      row("ATC", "Attendant care", "2026-07-01", "2026-12-31", "c"),
      row("RSP", "Respite", "2026-01-01", "2026-06-30", "a"),
      row("ATC", "Attendant care", "2026-01-01", "2026-06-30", "d"),
    ]);
    expect(sorted.map((r) => r.tag)).toEqual(["d", "c", "a", "b"]);
  });

  it("keeps server order for identical rows, does not change its input, and handles an empty list", () => {
    const input = [row("A", "x", "2026-01-01", "2026-02-01", "1"), row("A", "x", "2026-01-01", "2026-02-01", "2")];
    const copy = [...input];
    expect(sortMonthlyServiceRows(input).map((r) => r.tag)).toEqual(["1", "2"]);
    expect(input).toEqual(copy);
    expect(sortMonthlyServiceRows([])).toEqual([]);
  });
});
