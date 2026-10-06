import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ContinuityStatusCard } from "./continuity-page";
import { useOrganization } from "@/providers/organization-provider";
import { actionCategories, actionNeededState, reminders } from "./action-needed";
import { hoursLabel, moneyLabel, useAttention, useUtilisation, type UtilisationRow } from "./aws-workspace";

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const sum = (rows: UtilisationRow[], key: keyof UtilisationRow) => rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);
const sumMoney = (rows: UtilisationRow[], key: "billableValueCents" | "approvedValueCents" | "unusedValueCents") =>
  rows.some((r) => r[key] !== null) ? rows.reduce((t, r) => t + Number(r[key] ?? 0), 0) : null;

const cardClass = "rounded-og border border-og-line bg-og-card";

/** A small colour key beside a metric name. Colour is never the only signal: the name is always written. */
function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${className}`} />;
}

function Kpi({ label, value, valueClass = "text-og-ink", dot }: { label: string; value: string; valueClass?: string; dot?: string }) {
  return (
    <div className={`${cardClass} p-4`}>
      <p className={`font-og-mono text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-1 text-xs font-medium text-og-sub">{dot ? <Dot className={dot} /> : null}{label}</p>
    </div>
  );
}

function Th({ children, dot, numeric = false }: { children: ReactNode; dot?: string; numeric?: boolean }) {
  return (
    <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold text-og-sub ${numeric ? "text-right" : "text-left"}`}>
      {dot ? <Dot className={dot} /> : null}{children}
    </th>
  );
}

/**
 * Home for owners, managers and schedulers: what needs action, then the
 * month's authorized vs worked hours by service. Dollar values appear only
 * when the server returns them (billing.read: owner). Missing rates and
 * the absent caregiver-pay source are stated, never shown as $0.
 *
 * Presentation only: every value, count, link and permission check below is the one
 * this page already used; the layout and styling are what changed.
 */
export function AwsHomePage() {
  const { hasPermission, role } = useOrganization();
  const [month, setMonth] = useState(thisMonth);
  const attention = useAttention();
  const utilisation = useUtilisation(`${month}-01`);
  const rows = utilisation.data ?? [];
  const isOwnerFinance = hasPermission("billing.read");
  const a = attention.data;

  // One definition with the header badge (action-needed.ts): the same query, the same
  // category counts. The total is the sum of the category counts; reminders are shown
  // separately and never counted.
  const items = a ? actionCategories(a) : [];
  const reminderItems = a ? reminders(a) : [];
  const state = actionNeededState(attention.isLoading, attention.isError, a);

  const authorized = sum(rows, "authorizedMinutes");
  const worked = sum(rows, "workedMinutes");
  const missingRates = sum(rows, "lineagesWithoutRate");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-og-ink">Home</h1>
          {/* The same total as the header badge. Red above zero, green only for a confirmed zero, neutral while loading or when the check failed. */}
          <p
            role="status"
            data-testid="action-needed-banner"
            className={
              "rounded-full border-2 px-3 py-1 text-sm font-bold uppercase tracking-wide " +
              (state.kind === "attention" ? "border-red-700 bg-red-50 text-red-700"
                : state.kind === "clear" ? "border-emerald-700 bg-emerald-50 text-emerald-800"
                : "border-slate-400 bg-slate-50 text-slate-700")
            }
          >
            <span aria-hidden="true">{state.icon}</span>{" "}
            {state.kind === "attention" ? `Action needed: ${state.count}` : state.kind === "clear" ? "All clear: nothing needs action" : state.label}
          </p>
        </div>
        <label className="text-xs font-semibold text-og-sub">
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 block min-h-[40px] rounded-lg border border-og-line bg-white px-3 text-sm text-og-ink" />
        </label>
      </div>

      <section aria-labelledby="util-heading" className="space-y-3">
        <div>
          <h2 id="util-heading" className="text-lg font-bold text-og-ink">Hours this month</h2>
          <p className="text-xs text-og-sub">
            Utilization = worked hours ÷ authorized hours for the same client, service and month. Amended authorizations count once (the latest version).
          </p>
          <p className="text-xs">
            <Link className="inline-flex min-h-[40px] items-center font-semibold text-og-link underline" to="/service-verification/reports?view=reconciliation">
              By client and authorization: monthly reconciliation
            </Link>
          </p>
        </div>
        {utilisation.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {utilisation.isError ? <p role="alert" className="text-sm text-red-700">{(utilisation.error as Error).message}</p> : null}
        {!utilisation.isLoading && !utilisation.isError && rows.length === 0 ? (
          <p className="text-sm text-og-sub">No authorizations cover this month.</p>
        ) : null}
        {rows.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Authorized" value={hoursLabel(authorized)} />
              <Kpi label="Worked" value={hoursLabel(worked)} valueClass="text-og-worked" dot="bg-og-worked" />
              <Kpi label="Billable (confirmed)" value={hoursLabel(sum(rows, "billableMinutes"))} valueClass="text-og-billable" dot="bg-og-billable" />
              <Kpi label="Hours left" value={hoursLabel(sum(rows, "remainingMinutes"))} />
            </div>
            <div className={`${cardClass} p-4`}>
              <h3 className="text-sm font-bold text-og-ink">Worked vs authorized, by service</h3>
              {/* Wide on purpose: it scrolls sideways on a phone instead of squeezing the numbers. */}
              <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Worked vs authorized, by service (scrolls sideways on small screens)">
                <table className="w-full min-w-[820px] border-collapse text-sm">
                  <caption className="sr-only">Hours by service for the selected month</caption>
                  <thead>
                    <tr className="border-b border-og-line">
                      <Th>Service</Th>
                      <Th><Dot className="bg-og-worked" />Progress</Th>
                      <Th numeric dot="bg-og-billable">Billable</Th>
                      <Th numeric dot="bg-og-review">In review</Th>
                      <Th numeric dot="bg-og-approved">Approved</Th>
                      <Th numeric dot="bg-og-ahead">Scheduled ahead</Th>
                      <Th numeric>Hours left</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const pct = r.authorizedMinutes > 0 ? Math.round((r.workedMinutes / r.authorizedMinutes) * 100) : null;
                      const over = pct !== null && pct > 100;
                      return (
                        <tr key={r.serviceId} className="border-b border-og-line last:border-0 align-top">
                          <th scope="row" className="px-3 py-3 text-left font-semibold text-og-ink">
                            {r.serviceName}{" "}
                            <span className="block text-xs font-normal text-og-sub">({r.serviceCode} · {r.clientCount} {r.clientCount === 1 ? "client" : "clients"})</span>
                          </th>
                          <td className="min-w-[240px] px-3 py-3">
                            <span className="block font-og-mono text-xs tabular-nums text-og-ink">
                              {hoursLabel(r.workedMinutes)} of {hoursLabel(r.authorizedMinutes)}{pct !== null ? ` · ${pct}%` : " · no authorization"}
                            </span>
                            <div
                              className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-og-line"
                              role="img"
                              aria-label={`${r.serviceName}: ${hoursLabel(r.workedMinutes)} worked of ${hoursLabel(r.authorizedMinutes)} authorized`}
                              title={`${hoursLabel(r.workedMinutes)} worked of ${hoursLabel(r.authorizedMinutes)} authorized`}
                            >
                              <div className="h-full rounded-full bg-og-worked" style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
                            </div>
                            {over ? <p className="mt-1 text-xs font-semibold text-red-700">⚠ Over the authorization: review before billing</p> : null}
                          </td>
                          <td className="px-3 py-3 text-right font-og-mono tabular-nums">{hoursLabel(r.billableMinutes)}</td>
                          <td className="px-3 py-3 text-right font-og-mono tabular-nums">{hoursLabel(r.reviewMinutes)}</td>
                          <td className="px-3 py-3 text-right font-og-mono tabular-nums">{hoursLabel(r.approvedMinutes)}</td>
                          <td className="px-3 py-3 text-right font-og-mono tabular-nums">{hoursLabel(r.scheduledMinutes)}</td>
                          <td className="px-3 py-3 text-right font-og-mono tabular-nums">{hoursLabel(r.remainingMinutes)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            {isOwnerFinance ? (
              <section aria-labelledby="finance-heading" className="space-y-2 pt-2">
                <h3 id="finance-heading" className="text-sm font-bold text-og-ink">Financial impact (Administrator only)</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    ["Billable value", moneyLabel(sumMoney(rows, "billableValueCents")), "Billable hours × authorization rate. Not collected revenue."],
                    ["Approved for billing", moneyLabel(sumMoney(rows, "approvedValueCents")), "Snapshotted at approval. Approved is not submitted or paid."],
                    ["Potential value of unused hours", moneyLabel(sumMoney(rows, "unusedValueCents")), "Hours left × rate. Potential revenue not realized, not a loss."],
                    ["Caregiver cost and margin", null, "Unavailable: Ogevia has no caregiver pay data yet."],
                  ].map(([label, value, hint]) => (
                    <div key={label} className={`${cardClass} p-4`}>
                      <p className={value ? "font-og-mono text-2xl font-semibold tabular-nums text-og-ink" : "text-2xl font-semibold italic text-og-na"}>{value ?? "Unavailable"}</p>
                      <p className="mt-1 text-sm font-medium text-og-ink">{label}</p>
                      <p className="text-xs text-og-sub">{hint}</p>
                    </div>
                  ))}
                </div>
                {missingRates > 0 ? (
                  <p className="text-xs text-amber-800">
                    {missingRates} {missingRates === 1 ? "authorization has" : "authorizations have"} no rate; {missingRates === 1 ? "its" : "their"} hours are left out of the values above.
                  </p>
                ) : null}
              </section>
            ) : role !== "organization_owner" ? (
              <p className="text-xs text-og-sub">Dollar values, rates, costs and margins are visible to the agency Administrator only.</p>
            ) : null}
          </>
        ) : null}
      </section>

      <section id="attention" aria-labelledby="attention-heading" className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <h2 id="attention-heading" className="text-sm font-bold uppercase tracking-wide text-og-ink">Action needed</h2>
          {state.kind === "attention" ? <p className="mt-1 text-xs text-og-sub">The total adds up the counts below. One visit can appear in more than one count.</p> : null}
          {attention.isLoading ? <p className="mt-2 text-sm text-og-sub">Loading…</p> : null}
          {attention.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(attention.error as Error).message}</p> : null}
          {a ? (
            <ul className={`${cardClass} mt-2 divide-y divide-og-line overflow-hidden`}>
              {items.map((i) => (
                <li key={i.label}>
                  <Link
                    to={i.to}
                    className={
                      "flex min-h-[56px] items-center justify-between gap-3 border-l-4 px-4 py-3 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-og-link " +
                      (i.count > 0 ? "border-og-warn bg-og-warn-bg" : "border-transparent")
                    }
                  >
                    <span>
                      <span className="block text-sm font-semibold text-og-ink">{i.label}</span>
                      <span className="block text-xs text-og-sub">{i.hint}</span>
                    </span>
                    <span className={"font-og-mono text-2xl tabular-nums " + (i.count > 0 ? "font-bold text-og-warn" : "font-medium text-og-zero")}>
                      {i.count > 0 ? <span className="sr-only">Needs action: </span> : null}
                      {i.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="space-y-4">
          {a ? (
            <div className="rounded-og border-2 border-dashed border-og-line bg-og-card p-4">
              <h3 className="text-sm font-bold text-og-ink">Reminders (not counted)</h3>
              {reminderItems.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {reminderItems.map((i) => (
                    <li key={i.label}>
                      <Link to={i.to} className="flex min-h-[56px] items-center justify-between gap-3 rounded-lg border border-og-line bg-white px-3 py-2 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-og-link">
                        <span>
                          <span className="block text-sm font-semibold text-og-ink">{i.label}</span>
                          <span className="block text-xs text-og-sub">{i.hint}</span>
                        </span>
                        <span className="font-og-mono text-xl font-semibold tabular-nums text-og-ink">{i.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-og-sub">Nothing to remind you of right now.</p>
              )}
            </div>
          ) : null}
          <ContinuityStatusCard />
        </div>
      </section>
    </div>
  );
}
