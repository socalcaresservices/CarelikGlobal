// Documented default row order for screens that have no sort control, used by BOTH the screen and its export so the file always matches what is
// displayed (owner, 2026-11-20: "exported rows follow the same visible ordering shown on screen"). Pure functions; no sorting by a user's choice here:
// screens that have a sort control export the rows they display (the active sort) instead.
//
//   monthly service rows (calendar, reconciliation)  service code, service name A-Z, authorization period start, period end (oldest first)
//   monthly chain rows                               client code, service code, service name A-Z, period start, period end (oldest first)
//   billing submission items                         client name A-Z, service name A-Z, service date (oldest first)
//   correction history rows                          corrected on (newest first), then visit ref
//
// Text compares case-insensitively with numbers in natural order; empty values go last; ties keep the input order (stable).

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type Key = { v: string | number | null | undefined; desc?: boolean; date?: boolean };

const empty = (v: Key["v"]) => v === null || v === undefined || v === "";

function compareKeys(a: Key[], b: Key[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!.v, y = b[i]!.v;
    const ex = empty(x), ey = empty(y);
    if (ex || ey) {
      if (ex !== ey) return ex ? 1 : -1;   // empty last, whatever the direction
      continue;
    }
    let c = a[i]!.date ? Date.parse(String(x)) - Date.parse(String(y)) : typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    if (Number.isNaN(c)) c = 0;
    if (c !== 0) return a[i]!.desc ? -c : c;
  }
  return 0;
}

function ordered<T>(rows: readonly T[], keys: (row: T) => Key[]): T[] {
  return rows
    .map((row, i) => ({ row, i, k: keys(row) }))
    .sort((a, b) => compareKeys(a.k, b.k) || a.i - b.i)
    .map((x) => x.row);
}

const v = (value: unknown): Key["v"] => (typeof value === "string" || typeof value === "number" ? value : value === null || value === undefined ? null : String(value));

export function orderMonthlyServiceRows<T extends { serviceCode?: unknown; serviceName?: unknown; authorizationPeriodStart?: unknown; authorizationPeriodEnd?: unknown }>(rows: readonly T[]): T[] {
  return ordered(rows, (r) => [{ v: v(r.serviceCode) }, { v: v(r.serviceName) }, { v: v(r.authorizationPeriodStart), date: true }, { v: v(r.authorizationPeriodEnd), date: true }]);
}

export function orderChainRows<T extends { clientCode?: unknown; serviceCode?: unknown; serviceName?: unknown; periodStart?: unknown; periodEnd?: unknown }>(rows: readonly T[]): T[] {
  return ordered(rows, (r) => [{ v: v(r.clientCode) }, { v: v(r.serviceCode) }, { v: v(r.serviceName) }, { v: v(r.periodStart), date: true }, { v: v(r.periodEnd), date: true }]);
}

export function orderBillingSubmissionItems<T extends { client_name?: unknown; service_name?: unknown; service_date?: unknown }>(rows: readonly T[]): T[] {
  return ordered(rows, (r) => [{ v: v(r.client_name) }, { v: v(r.service_name) }, { v: v(r.service_date), date: true }]);
}

export function orderCorrectionRows<T extends { createdAt?: unknown; visitNumber?: unknown }>(rows: readonly T[]): T[] {
  return ordered(rows, (r) => [{ v: v(r.createdAt), date: true, desc: true }, { v: v(r.visitNumber) }]);
}
