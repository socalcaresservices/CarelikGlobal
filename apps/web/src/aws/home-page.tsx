import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ContinuityStatusCard } from "./continuity-page";
import { useOrganization } from "@/providers/organization-provider";
import { streams, TONE, useAttentionOverview, type Stream } from "./attention";
import { hoursLabel, useUtilisation, type UtilisationRow } from "./aws-workspace";
import { financeView } from "./finance-view";
import { Chart } from "./ui/chart";
import { QuickActions, RefreshStatus, TodaysVisits } from "./home-extras";
import { agencyMonth, useAgencyClock } from "./agency-clock";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";

const sum = (rows: UtilisationRow[], key: keyof UtilisationRow) => rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);

function Tile({ s }: { s: Stream }) {
  const t = TONE[s.tone];
  const hot = s.tone !== "neutral";
  return (
    <li>
      <Link
        to={s.to}
        data-testid={`stream-${s.key}`}
        className={`flex h-full min-h-[88px] flex-col justify-between gap-1 rounded-og border bg-og-card p-3 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link ${s.tone === "red" ? "border-red-700" : s.tone === "amber" ? "border-amber-600" : "border-og-line"}`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-og-ink">{s.label}</span>
          {hot ? <StatusChip tone={s.tone}>{s.word ?? t.word}</StatusChip> : null}
        </span>
        <span>
          <span className="font-og-mono text-2xl font-semibold tabular-nums text-og-ink">{s.count}</span>
          <span className="ml-1.5 text-sm text-og-sub">{s.unit}</span>
        </span>
        <span className="text-xs text-og-sub">{s.detail}</span>
      </Link>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" }) {
  return (
    <div>
      <dt className="text-xs font-medium text-og-sub">{label}</dt>
      <dd className={`font-og-mono text-xl font-semibold tabular-nums ${tone === "red" ? "text-red-700" : "text-og-ink"}`}>{tone === "red" ? <span aria-hidden="true">● </span> : null}{value}</dd>
    </div>
  );
}

/**
 * Home for owners, managers and schedulers: what needs attention (four purposes, each with its own page), then the month's hours.
 * Dollar values appear only when the server returns them (billing.read: owner). Definitions sit behind "How these are calculated".
 */
export function AwsHomePage() {
  const { hasPermission } = useOrganization();
  const { tz } = useAgencyClock();
  const [month, setMonth] = useState(() => agencyMonth(tz)); // the AGENCY's month, not the browser's (F7)
  const overview = useAttentionOverview();
  const utilisation = useUtilisation(`${month}-01`);
  const queryClient = useQueryClient();
  const refresh = () => {
    void overview.refetch();
    void utilisation.refetch();
    void queryClient.invalidateQueries({ queryKey: ["aws-shifts"] });
  };
  const rows = utilisation.data ?? [];
  const isOwnerFinance = hasPermission("billing.read");
  const tiles = overview.data ? streams(overview.data) : [];
  const finance = financeView(rows);
  const over = rows.filter((r) => r.authorizedMinutes > 0 && r.workedMinutes > r.authorizedMinutes);
  // The approved tiers (0057): Critical 95% and above of committed, Near Limit 80% to below 95%; expiry within 30 days is separate.
  const crit = sum(rows, "criticalAuthorizations"), near = sum(rows, "nearLimitAuthorizations"), ending = sum(rows, "expiringAuthorizations");
  const tierBits = [crit ? `● ${crit} Critical` : null, near ? `▲ ${near} Near Limit` : null, ending ? `▲ ${ending} ending within 30 days` : null].filter(Boolean);
  const tierSummary = tierBits.length ? `Authorizations: ${tierBits.join(" · ")}` : null;
  const chartData = rows.filter((r) => r.workedMinutes > 0).map((r) => ({ label: r.serviceName, value: r.workedMinutes, display: hoursLabel(r.workedMinutes) }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home"
        action={
          <label className="text-xs font-semibold text-og-sub">
            Month
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 block min-h-[40px] rounded-lg border border-og-line bg-og-card px-3 text-sm text-og-ink" />
          </label>
        }
      />
      <RefreshStatus overview={overview.data} loading={overview.isLoading} failed={overview.isError} refreshing={overview.isFetching || utilisation.isFetching} onRefresh={refresh} />

      <section aria-label="What needs attention">
        {overview.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {tiles.length > 0 ? <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{tiles.map((s) => <Tile key={s.key} s={s} />)}</ul> : null}
      </section>

      <QuickActions />

      <TodaysVisits />

      <section aria-labelledby="util-heading" className="space-y-3">
        <h2 id="util-heading" className="text-lg font-bold text-og-ink">Hours this month</h2>
        {utilisation.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {utilisation.isError ? <p role="alert" className="text-sm text-red-700">{(utilisation.error as Error).message}</p> : null}
        {!utilisation.isLoading && !utilisation.isError && rows.length === 0 ? <p className="text-sm text-og-sub">No authorizations cover this month.</p> : null}
        {rows.length > 0 ? (
          <div className="space-y-4 rounded-og border border-og-line bg-og-card p-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              <Stat label="Authorized" value={hoursLabel(sum(rows, "authorizedMinutes"))} />
              <Stat label="Worked" value={hoursLabel(sum(rows, "workedMinutes"))} />
              <Stat label="Billable (confirmed)" value={hoursLabel(sum(rows, "billableMinutes"))} />
              <Stat label="Hours left" value={hoursLabel(sum(rows, "remainingMinutes"))} />
              {sum(rows, "overLimitMinutes") > 0 ? <Stat label="Over the limit" value={hoursLabel(sum(rows, "overLimitMinutes"))} tone="red" /> : null}
            </dl>
            {tierSummary ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="authorization-tiers">{tierSummary}</p>
            ) : null}
            {sum(rows, "needsReconciliationMinutes") > 0 ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="needs-reconciliation">
                {hoursLabel(sum(rows, "needsReconciliationMinutes"))} are reserved on shifts that ended with no visit record. They stay counted until a person decides. <Link className="underline" to="/schedule">Reconcile shifts</Link>
              </p>
            ) : null}
            {over.length > 0 ? (
              <p role="status" className="text-sm font-semibold text-red-700">
                <span aria-hidden="true">● </span>Over the authorization: {over.map((r) => r.serviceName).join(", ")}. Review before billing.
              </p>
            ) : null}
            {chartData.length > 0 ? <Chart title="Worked hours by service" data={chartData} shape="parts-of-whole" unit="worked hours" total={hoursLabel(sum(rows, "workedMinutes"))} /> : null}
            <Disclosure summary="Hours by service, and how these are calculated">
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Hours by service (scrolls sideways on small screens)">
                <table className="w-full min-w-[820px] border-collapse text-sm">
                  <caption className="sr-only">Hours by service for the selected month</caption>
                  <thead>
                    <tr className="border-b border-og-line text-left text-xs font-semibold text-og-sub">
                      <th scope="col" className="py-2 pr-3">Service</th>
                      <th scope="col" className="px-3 py-2 text-right">Authorized</th>
                      <th scope="col" className="px-3 py-2 text-right">Worked</th>
                      <th scope="col" className="px-3 py-2 text-right">Billable</th>
                      <th scope="col" className="px-3 py-2 text-right">In review</th>
                      <th scope="col" className="px-3 py-2 text-right">Approved</th>
                      <th scope="col" className="px-3 py-2 text-right">Scheduled ahead</th>
                      <th scope="col" className="px-3 py-2 text-right">Held for confirmation or review</th>
                      <th scope="col" className="px-3 py-2 text-right">To reconcile</th>
                      <th scope="col" className="px-3 py-2 text-right">Committed</th>
                      <th scope="col" className="px-3 py-2 text-right">Left</th>
                      <th scope="col" className="py-2 pl-3 text-right">Over limit</th>
                    </tr>
                  </thead>
                  <tbody className="font-og-mono tabular-nums text-og-ink">
                    {rows.map((r) => (
                      <tr key={r.serviceId} className="border-b border-og-line last:border-0">
                        <th scope="row" className="py-2 pr-3 text-left font-sans font-semibold">{r.serviceName} <span className="font-normal text-og-sub">({r.serviceCode} · {r.clientCount} {r.clientCount === 1 ? "client" : "clients"})</span></th>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.authorizedMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.workedMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.billableMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.reviewMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.approvedMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.scheduledMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.heldReviewMinutes ?? 0)}</td>
                        <td className={`px-3 py-2 text-right ${(r.needsReconciliationMinutes ?? 0) > 0 ? "font-semibold text-amber-900" : ""}`}>{hoursLabel(r.needsReconciliationMinutes ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.committedMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.remainingMinutes)}</td>
                        <td className={`py-2 pl-3 text-right ${(r.overLimitMinutes ?? 0) > 0 ? "font-semibold text-red-700" : ""}`}>{hoursLabel(r.overLimitMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2">Committed = billable + approved rounding adjustments + reserved. Authorized − committed = Left − Over limit.</p>
              <p className="mt-1">Reserved is Scheduled ahead (including a shift that has started), Held for confirmation or review (the visit has ended or is in review), and To reconcile: ended with no visit record, released only by a person.</p>
              <p className="mt-1">Left adds up each authorization's unused time only, so one over its limit never uses up another's hours.</p>
              <p className="mt-1">Healthy is below 80% committed, Near Limit 80% to below 95%, Critical 95% and above. An amended authorization counts once (its latest version).</p>
              <p className="mt-1">Billable means confirmed. Approved means a person approved it for billing. Neither means submitted or paid.</p>
              <p className="mt-1"><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=reconciliation">Monthly reconciliation by client and authorization</Link></p>
            </Disclosure>
          </div>
        ) : null}
      </section>

      {isOwnerFinance && finance.showSection ? (
        <section aria-labelledby="finance-heading" className="space-y-3">
          <h2 id="finance-heading" className="text-lg font-bold text-og-ink">Financial impact</h2>
          <div className="space-y-3 rounded-og border border-og-line bg-og-card p-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
              {finance.items.map((i) => (
                <div key={i.key}>
                  <dt className="text-xs font-medium text-og-sub">{i.label}</dt>
                  {i.value ? <dd className="font-og-mono text-xl font-semibold tabular-nums text-og-ink">{i.value}</dd> : i.empty ? <dd className="text-sm text-og-sub">{i.empty}</dd> : <dd className="text-sm text-og-sub">Not calculated</dd>}
                </div>
              ))}
            </dl>
            {finance.missingRates > 0 ? (
              <p role="status" className="flex flex-wrap items-center gap-x-3 text-sm text-amber-900" data-testid="missing-rate-message">
                <span><span aria-hidden="true">▲ </span>{finance.missingRates} {finance.missingRates === 1 ? "authorization has" : "authorizations have"} no hourly rate, so {finance.missingRates === 1 ? "its" : "their"} hours are left out of these values.</span>
                <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to={`/authorizations/rates?month=${month}`}>Review authorizations</Link>
              </p>
            ) : null}
            <Disclosure summary="What these values mean">
              <p>Billable value is billable hours × the authorization rate. It is not collected revenue.</p>
              <p className="mt-1">Approved for billing is fixed when a person approves it. Approved is not submitted or paid.</p>
              <p className="mt-1">Unused hours are hours left × the rate: potential revenue not realized, not a loss.</p>
              <p className="mt-1">Caregiver cost and margin are not shown because Ogevia has no caregiver pay data.</p>
            </Disclosure>
          </div>
        </section>
      ) : null}

      <ContinuityStatusCard />
    </div>
  );
}
