import { useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@carelik/ui";
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

/**
 * Home for owners, managers and schedulers: what needs action, then the
 * month's authorized vs worked hours by service. Dollar values appear only
 * when the server returns them (billing.read: owner). Missing rates and
 * the absent caregiver-pay source are stated, never shown as $0.
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
      <h1 className="text-xl font-semibold text-slate-950">Home</h1>
      <ContinuityStatusCard />

      <section id="attention" aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="text-sm font-bold uppercase tracking-wide text-slate-700">Action needed</h2>
        {/* Banner: the same total as the header badge. Red above zero, green only for a confirmed zero, neutral while loading or when the check failed. */}
        <p
          role="status"
          data-testid="action-needed-banner"
          className={
            "mt-2 rounded-xl border-2 px-4 py-3 text-base font-bold uppercase tracking-wide " +
            (state.kind === "attention" ? "border-red-700 bg-red-50 text-red-700"
              : state.kind === "clear" ? "border-emerald-700 bg-emerald-50 text-emerald-800"
              : "border-slate-400 bg-slate-50 text-slate-700")
          }
        >
          <span aria-hidden="true">{state.icon}</span>{" "}
          {state.kind === "attention" ? `Action needed: ${state.count}` : state.kind === "clear" ? "All clear: nothing needs action" : state.label}
        </p>
        {state.kind === "attention" ? <p className="mt-1 text-xs text-slate-500">The total adds up the counts below. One visit can appear in more than one count.</p> : null}
        {attention.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
        {attention.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(attention.error as Error).message}</p> : null}
        {a ? (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {items.map((i) => (
              <li key={i.label}>
                <Link to={i.to} className="flex min-h-[56px] items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-slate-300">
                  <span>
                    <span className="block text-sm font-medium text-slate-900">{i.label}</span>
                    <span className="block text-xs text-slate-500">{i.hint}</span>
                  </span>
                  <span className={i.count > 0 ? "text-2xl font-bold tabular-nums text-red-700" : "text-2xl font-semibold tabular-nums text-slate-400"}>{i.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {reminderItems.length > 0 ? (
          <>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Reminders (not in the Action needed total)</h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {reminderItems.map((i) => (
                <li key={i.label}>
                  <Link to={i.to} className="flex min-h-[56px] items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-slate-300">
                    <span>
                      <span className="block text-sm font-medium text-slate-900">{i.label}</span>
                      <span className="block text-xs text-slate-500">{i.hint}</span>
                    </span>
                    <span className="text-2xl font-semibold tabular-nums text-slate-600">{i.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section aria-labelledby="util-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="util-heading" className="text-lg font-semibold text-slate-950">Hours this month (utilization)</h2>
            <p className="text-xs text-slate-500">
              Utilization = worked hours ÷ authorized hours for the same client, service and month. Amended authorizations count once (the latest version).
            </p>
            <p className="text-xs">
              <Link className="font-medium text-slate-800 underline" to="/service-verification/reports?view=reconciliation">
                By client and authorization: monthly reconciliation
              </Link>
            </p>
          </div>
          <label className="text-xs font-medium text-slate-600">
            Month
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </label>
        </div>
        {utilisation.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {utilisation.isError ? <p role="alert" className="text-sm text-red-700">{(utilisation.error as Error).message}</p> : null}
        {!utilisation.isLoading && !utilisation.isError && rows.length === 0 ? (
          <p className="text-sm text-slate-500">No authorizations cover this month.</p>
        ) : null}
        {rows.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                ["Authorized", hoursLabel(authorized)],
                ["Worked", hoursLabel(worked)],
                ["Billable (confirmed)", hoursLabel(sum(rows, "billableMinutes"))],
                ["Hours left", hoursLabel(sum(rows, "remainingMinutes"))],
              ].map(([label, value]) => (
                <Card key={label} className="p-3">
                  <p className="text-xl font-semibold tabular-nums text-slate-950">{value}</p>
                  <p className="text-xs text-slate-600">{label}</p>
                </Card>
              ))}
            </div>
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-slate-900">Worked vs authorized, by service</h3>
              <ul className="mt-3 space-y-4">
                {rows.map((r) => {
                  const pct = r.authorizedMinutes > 0 ? Math.round((r.workedMinutes / r.authorizedMinutes) * 100) : null;
                  const over = pct !== null && pct > 100;
                  return (
                    <li key={r.serviceId}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium text-slate-900">{r.serviceName} <span className="text-xs text-slate-500">({r.serviceCode} · {r.clientCount} {r.clientCount === 1 ? "client" : "clients"})</span></span>
                        <span className="tabular-nums text-slate-700">
                          {hoursLabel(r.workedMinutes)} of {hoursLabel(r.authorizedMinutes)}{pct !== null ? ` · ${pct}%` : " · no authorization"}
                        </span>
                      </div>
                      <div
                        className="mt-1 h-3 w-full overflow-hidden rounded bg-blue-100"
                        role="img"
                        aria-label={`${r.serviceName}: ${hoursLabel(r.workedMinutes)} worked of ${hoursLabel(r.authorizedMinutes)} authorized`}
                        title={`${hoursLabel(r.workedMinutes)} worked of ${hoursLabel(r.authorizedMinutes)} authorized`}
                      >
                        <div className="h-full rounded bg-blue-600" style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
                      </div>
                      {over ? <p className="mt-1 text-xs font-semibold text-red-700">⚠ Over the authorization: review before billing</p> : null}
                      <p className="mt-1 text-xs text-slate-500">
                        Billable {hoursLabel(r.billableMinutes)} · In review {hoursLabel(r.reviewMinutes)} · Approved {hoursLabel(r.approvedMinutes)} · Scheduled ahead {hoursLabel(r.scheduledMinutes)} · Hours left {hoursLabel(r.remainingMinutes)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Card>
            {isOwnerFinance ? (
              <section aria-labelledby="finance-heading" className="space-y-2">
                <h3 id="finance-heading" className="text-sm font-semibold text-slate-900">Financial impact (Administrator only)</h3>
                <div className="grid gap-2 md:grid-cols-2">
                  {[
                    ["Billable value", moneyLabel(sumMoney(rows, "billableValueCents")), "Billable hours × authorization rate. Not collected revenue."],
                    ["Approved for billing", moneyLabel(sumMoney(rows, "approvedValueCents")), "Snapshotted at approval. Approved is not submitted or paid."],
                    ["Potential value of unused hours", moneyLabel(sumMoney(rows, "unusedValueCents")), "Hours left × rate. Potential revenue not realized, not a loss."],
                    ["Caregiver cost and margin", null, "Unavailable: Ogevia has no caregiver pay data yet."],
                  ].map(([label, value, hint]) => (
                    <Card key={label} className="p-3">
                      <p className="text-xl font-semibold tabular-nums text-slate-950">{value ?? "Unavailable"}</p>
                      <p className="text-sm text-slate-700">{label}</p>
                      <p className="text-xs text-slate-500">{hint}</p>
                    </Card>
                  ))}
                </div>
                {missingRates > 0 ? (
                  <p className="text-xs text-amber-800">
                    {missingRates} {missingRates === 1 ? "authorization has" : "authorizations have"} no rate; {missingRates === 1 ? "its" : "their"} hours are left out of the values above.
                  </p>
                ) : null}
              </section>
            ) : role !== "organization_owner" ? (
              <p className="text-xs text-slate-500">Dollar values, rates, costs and margins are visible to the agency Administrator only.</p>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
