import { compareValues } from "./table-sort";

/** Calendar CSV and on-screen service rows in one fixed order: service code, service name (A-Z), then authorization period (oldest first); ties keep server order. */
export function sortMonthlyServiceRows<T extends { serviceCode: string; serviceName: string; authorizationPeriodStart: string | null; authorizationPeriodEnd: string | null }>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        compareValues(a.row.serviceCode, b.row.serviceCode) ||
        compareValues(a.row.serviceName, b.row.serviceName) ||
        compareValues(a.row.authorizationPeriodStart, b.row.authorizationPeriodStart, "date") ||
        compareValues(a.row.authorizationPeriodEnd, b.row.authorizationPeriodEnd, "date") ||
        a.i - b.i,
    )
    .map((x) => x.row);
}
