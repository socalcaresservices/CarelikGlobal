// Below the client monthly calendar: caregiver summary (names, time per
// service, total), service totals (authorized, worked, billable, still
// scheduled, remaining), the overall worked total with a to-the-minute
// cross-check, work not yet complete, and an optional visit detail page.
import type { ClientMonthSummary } from "@/lib/client-month-summary";
import type { MonthlyServiceSummaryRow } from "@/lib/sv-backend";
import { formatDateOnly, formatDuration, formatTimeRange, VISIT_STATUS_LABEL } from "@/lib/service-verification";
import { formatHours } from "@/lib/hours-accounting";

type LoadState = "loading" | "error" | "ready";

/** One authorization: "Hours left" as a time, or "Over limit" with the amount over (0079); never offset against another authorization. */
const overOrLeft = (minutes: number) => (minutes < 0 ? `Over limit: ${formatHours(-minutes)}` : formatHours(minutes));
const th = "pb-1 pr-3 font-medium print:pb-0.5 print:pr-2";
const td = "whitespace-nowrap py-1 pr-3 tabular-nums print:py-0 print:pr-2";

export function CalendarSummary({
  summary,
  serviceRows,
  serviceRowsState,
  visitsState,
  detailPage,
}: {
  summary: ClientMonthSummary;
  serviceRows: MonthlyServiceSummaryRow[];
  serviceRowsState: LoadState;
  visitsState: LoadState;
  detailPage: boolean;
}) {
  const { services, caregivers } = summary;
  const totals = serviceRows.reduce(
    (t, r) => ({
      authorized: t.authorized + r.authorizedMinutes,
      worked: t.worked + r.workedMinutes,
      billable: t.billable + r.billableMinutes,
      reserved: t.reserved + (r.hoursReservedMinutes ?? r.reservedMinutes ?? 0),
      pending: t.pending + (r.hoursPendingMinutes ?? 0),
      // A total counts each authorization's unused time only; one that is over its limit never uses up another's, and the overage is shown beside it.
      remaining: t.remaining + Math.max(r.hoursLeftMinutes ?? r.remainingMinutes, 0),
      over: t.over + Math.max(-(r.hoursLeftMinutes ?? r.remainingMinutes), 0),
    }),
    { authorized: 0, worked: 0, billable: 0, reserved: 0, pending: 0, remaining: 0, over: 0 },
  );
  const ready = serviceRowsState === "ready" && visitsState === "ready";

  return (
    <div className="mt-5 space-y-4 text-sm print:mt-1.5 print:space-y-1 print:text-[9px] print:leading-tight">
      <div className="grid gap-4 lg:grid-cols-2 print:grid-cols-2 print:gap-3">
        <section aria-labelledby="cal-caregivers" className="min-w-0">
          <h4 id="cal-caregivers" className="font-semibold text-slate-950 print:text-[10px]">Caregiver summary</h4>
          {visitsState === "loading" ? (
            <p className="mt-1 text-slate-500">Loading…</p>
          ) : visitsState === "error" ? (
            <p role="alert" className="mt-1 text-red-700">Could not load this month's visits.</p>
          ) : caregivers.length === 0 ? (
            <p className="mt-1 text-slate-500">No counted visits this month.</p>
          ) : (
            <div className="mt-1 overflow-x-auto print:overflow-visible">
            <table className="w-full text-left" aria-label="Caregiver summary">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 print:text-[8px]">
                  <th className={th}>Caregiver</th>
                  {services.map((s) => (
                    <th key={s.serviceId} className={th}>{s.serviceName}</th>
                  ))}
                  <th className={th}>Total</th>
                </tr>
              </thead>
              <tbody>
                {caregivers.map((c) => (
                  <tr key={c.caregiverUserId} className="border-b border-slate-100">
                    <td className="py-1 pr-3 font-medium text-slate-800 print:py-0 print:pr-2">{c.caregiverName}</td>
                    {services.map((s) => (
                      <td key={s.serviceId} className={td}>{formatDuration(c.minutesByService.get(s.serviceId) ?? 0)}</td>
                    ))}
                    <td className={`${td} font-semibold`}>{formatDuration(c.totalMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </section>

        <section aria-labelledby="cal-services" className="min-w-0">
          <h4 id="cal-services" className="font-semibold text-slate-950 print:text-[10px]">Service totals</h4>
          {serviceRowsState === "loading" ? (
            <p className="mt-1 text-slate-500">Loading totals…</p>
          ) : serviceRowsState === "error" ? (
            <p role="alert" className="mt-1 text-red-700">Could not load the service totals.</p>
          ) : serviceRows.length === 0 ? (
            <p className="mt-1 text-slate-500">No authorization covers this client and month.</p>
          ) : (
            <div className="mt-1 overflow-x-auto print:overflow-visible">
            <table className="w-full text-left" aria-label="Monthly service totals">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 print:text-[8px]">
                  <th className={th}>Service</th>
                  <th className={th}>Authorized</th>
                  <th className={th}>Worked</th>
                  <th className={th}>Billable</th>
                  <th className={th}>Pending</th>
                  <th className={th}>Reserved</th>
                  <th className={th}>Hours left</th>
                </tr>
              </thead>
              <tbody>
                {serviceRows.map((r) => (
                  <tr key={r.authorizationLineageId} className="border-b border-slate-100">
                    <td className="py-1 pr-3 font-medium text-slate-800 print:py-0 print:pr-2">
                      {r.serviceCode} · {r.serviceName}
                      {r.reviewMinutes > 0 ? <span className="block text-xs text-amber-800 print:text-[8px]">In review {formatDuration(r.reviewMinutes)}</span> : null}
                    </td>
                    <td className={td}>{formatDuration(r.authorizedMinutes)}</td>
                    <td className={td}>{formatDuration(r.workedMinutes)}</td>
                    <td className={td}>{formatDuration(r.hoursBillableMinutes ?? r.billableMinutes)}</td>
                    <td className={td}>{formatDuration(r.hoursPendingMinutes ?? 0)}</td>
                    <td className={td}>{formatDuration(r.hoursReservedMinutes ?? r.reservedMinutes ?? 0)}</td>
                    <td className={`${td} ${(r.hoursLeftMinutes ?? r.remainingMinutes) < 0 ? "font-semibold text-red-700" : ""}`}>{overOrLeft(r.hoursLeftMinutes ?? r.remainingMinutes)}</td>
                  </tr>
                ))}
                {serviceRows.length > 1 ? (
                  <tr className="font-semibold">
                    <td className="py-1 pr-3 print:py-0">All services</td>
                    <td className={td}>{formatDuration(totals.authorized)}</td>
                    <td className={td}>{formatDuration(totals.worked)}</td>
                    <td className={td}>{formatDuration(totals.billable)}</td>
                    <td className={td}>{formatDuration(totals.pending)}</td>
                    <td className={td}>{formatDuration(totals.reserved)}</td>
                    <td className={td}>{formatHours(totals.remaining)}{totals.over > 0 ? <span className="block text-xs text-red-700">Over limit: {formatHours(totals.over)}</span> : null}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="font-semibold text-slate-950">
          Total worked this month: {formatDuration(summary.dailyTotalMinutes)}
          <span className="font-normal text-slate-600"> · billable {formatDuration(summary.billableTotalMinutes)}</span>
        </p>
        {!ready ? null : summary.reconciles ? (
          <p className="text-emerald-800">✓ Daily, caregiver and service totals agree to the minute.</p>
        ) : (
          <p role="alert" className="font-semibold text-red-700">
            ⚠ Totals do not agree:{" "}
            {summary.checks
              .filter((c) => c.calendarMinutes !== (c.serverMinutes ?? 0))
              .map((c) => `${c.serviceName} calendar ${formatDuration(c.calendarMinutes)} vs service total ${formatDuration(c.serverMinutes ?? 0)}`)
              .join("; ") || `daily ${formatDuration(summary.dailyTotalMinutes)} vs caregivers ${formatDuration(summary.caregiverTotalMinutes)}`}
            . Do not bill from this page until resolved.
          </p>
        )}
      </div>

      <section aria-labelledby="cal-incomplete">
        <h4 id="cal-incomplete" className="font-semibold text-slate-950 print:text-[10px]">Not yet complete (not counted above)</h4>
        {summary.incomplete.length === 0 ? (
          <p className="text-slate-500">None.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {summary.incomplete.map((v) => (
              <li key={v.id}>
                {formatDateOnly(v.service_date)} · {formatTimeRange(v.time_in, v.time_out)} · {v.caregiver_name} · {v.service_name} ·{" "}
                <span className="font-medium">{VISIT_STATUS_LABEL[v.status] ?? v.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detailPage ? (
        <section aria-labelledby="cal-detail" className="print:break-before-page">
          <h4 id="cal-detail" className="font-semibold text-slate-950 print:text-[11px]">Visit detail (counted visits)</h4>
          <div className="mt-1 overflow-x-auto print:overflow-visible">
            <table className="w-full text-left" aria-label="Visit detail">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 print:text-[8px]">
                <th className={th}>Date</th>
                <th className={th}>Time</th>
                <th className={th}>Caregiver</th>
                <th className={th}>Service</th>
                <th className={th}>Worked</th>
                <th className={th}>Billable</th>
                <th className={th}>Status</th>
                <th className={th}>Visit</th>
              </tr>
            </thead>
            <tbody>
              {summary.counted.map((v) => (
                <tr key={v.id} className="border-b border-slate-100 print:break-inside-avoid">
                  <td className={td}>{formatDateOnly(v.service_date)}</td>
                  <td className={td}>{formatTimeRange(v.time_in, v.time_out)}</td>
                  <td className={td}>{v.caregiver_name}</td>
                  <td className={td}>{v.service_name}</td>
                  <td className={td}>{formatDuration(v.worked_minutes ?? 0)}</td>
                  <td className={td}>{formatDuration(v.billable_minutes ?? 0)}</td>
                  <td className={td}>{VISIT_STATUS_LABEL[v.status] ?? v.status}</td>
                  <td className={`${td} font-mono text-xs print:text-[8px]`}>{v.visit_number ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Above the client monthly calendar: the month's AUTHORISED hours for each service of the selected client, one line per service ("Respite — Authorised: 40 h").
 * The figures are the server's monthly summary (one row per authorization, an amended authorization counted once); nothing is recomputed here beyond adding the
 * rows of one service. It is shown once for the month, never inside a day or a shift, and it is not the Hours left breakdown (that stays in Details elsewhere).
 */
export function CalendarAuthorizedHours({ rows, state }: { rows: MonthlyServiceSummaryRow[]; state: LoadState }) {
  if (state === "loading") return <p role="status" className="text-sm text-slate-500 print:hidden" data-testid="authorised-hours-loading">Loading authorised hours…</p>;
  if (state === "error") return <p role="alert" className="text-sm text-red-700 print:hidden" data-testid="authorised-hours-error">Authorised hours could not be loaded. They are not shown as zero.</p>;
  const byService = new Map<string, { name: string; minutes: number }>();
  for (const r of rows) {
    const cur = byService.get(r.serviceId) ?? { name: r.serviceName, minutes: 0 };
    byService.set(r.serviceId, { name: cur.name, minutes: cur.minutes + r.authorizedMinutes });
  }
  const list = [...byService.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return <p className="text-sm text-slate-600 print:hidden" data-testid="authorised-hours-none">No authorization this month</p>;
  return (
    <ul aria-label="Authorised hours by service for the month" className="flex flex-wrap gap-x-6 gap-y-0.5 text-sm text-slate-900 print:hidden" data-testid="authorised-hours">
      {list.map((s) => (
        <li key={s.name}><span className="font-medium">{s.name}</span> — Authorised: {formatHours(s.minutes)}</li>
      ))}
    </ul>
  );
}
