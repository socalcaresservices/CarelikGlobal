import { HOURS_DEFINITIONS, HOURS_EQUATION_TEXT, HOURS_TOTAL_NOTE } from "@/lib/hours-accounting";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ContinuityStatusCard } from "./continuity-page";
import { useOrganization } from "@/providers/organization-provider";
import { streams, TONE, useAttentionOverview, type Stream } from "./attention";
import { hoursLabel, useUtilisation, type UtilisationRow } from "./aws-workspace";
import { financeView } from "./finance-view";
import { Chart } from "./ui/chart";
import { CollapseButton, QuickActions, RefreshStatus, TodaysVisits, TopIssues } from "./home-extras";
import { useCollapsed } from "./home-data";
import { agencyMonth, useAgencyClock } from "./agency-clock";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";

const sum = (rows: UtilisationRow[], key: keyof UtilisationRow) => rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);

/** Zero-state sentences ("Nothing overdue...") are not worth a line on a compact tile: the zero and the unit already say it. */
const QUIET = /^(Nothing|Every)\b/;

function Tile({ s }: { s: Stream }) {
  const t = TONE[s.tone];
  const hot = s.tone !== "neutral";
  return (
    <li>
      <Link
        to={s.to}
        data-testid={`stream-${s.key}`}
        className={`flex h-full min-h-[44px] flex-col gap-0.5 rounded-og border bg-og-card px-3 py-2 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link ${s.tone === "red" ? "border-red-700" : s.tone === "amber" ? "border-amber-600" : "border-og-line"}`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-og-ink">{s.label}</span>
          {hot ? <StatusChip tone={s.tone}>{s.word ?? t.word}</StatusChip> : null}
        </span>
        <span>
          <span className="font-og-mono text-xl font-semibold tabular-nums text-og-ink">{s.count}</span>
          <span className="ml-1.5 text-sm text-og-sub">{s.unit}</span>
        </span>
        {s.count === 0 && QUIET.test(s.detail) ? null : <span className="text-xs text-og-sub">{s.detail}</span>}
      </Link>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" }) {
  return (
    <div>
      <dt className="text-xs font-medium text-og-sub">{label}</dt>
      <dd className={`font-og-mono text-lg font-semibold tabular-nums ${tone === "red" ? "text-red-700" : "text-og-ink"}`}>{tone === "red" ? <span aria-hidden="true">● </span> : null}{value}</dd>
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
  const [hoursFolded, toggleHours] = useCollapsed("hours", true);
  const [financeFolded, toggleFinance] = useCollapsed("finance", true);
  const utilisation = useUtilisation(`${month}-01`);
  const queryClient = useQueryClient();
  const refresh = () => {
    void overview.refetch();
    void utilisation.refetch();
    void queryClient.invalidateQueries({ queryKey: ["action-issues"] });
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

  const workedLabel = hoursLabel(sum(rows, "workedMinutes"));
  // 0079: the server's per-authorization buckets summed by service. Hours left adds only authorizations with time left and Over limit only those over (never netted).
  const hasHoursData = rows.length > 0 && rows.every((r) => r.hoursLeftMinutes !== undefined && r.hoursLeftMinutes !== null);
  const overLimit = hasHoursData ? sum(rows, "hoursOverLimitMinutes") : sum(rows, "overLimitMinutes");
  const leftTotal = hasHoursData ? sum(rows, "hoursLeftMinutes") : sum(rows, "remainingMinutes");
  const billable = finance.items[0];
  return (
    <div className="space-y-5">
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
        {tiles.length > 0 ? <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">{tiles.map((s) => <Tile key={s.key} s={s} />)}</ul> : null}
      </section>

      <TopIssues />

      <QuickActions />

      <TodaysVisits />

      <section aria-labelledby="util-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 id="util-heading" className="text-lg font-bold text-og-ink">Hours this month</h2>
          {rows.length > 0 ? <CollapseButton collapsed={hoursFolded} onToggle={toggleHours} label="the hours" /> : null}
        </div>
        {utilisation.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {utilisation.isError ? <p role="alert" className="text-sm text-red-700" data-testid="hours-error">The hours could not be loaded. They are not shown as zero. <button type="button" className="font-semibold underline" onClick={() => void utilisation.refetch()}>Retry</button></p> : null}
        {!utilisation.isLoading && !utilisation.isError && rows.length === 0 ? <p className="text-sm text-og-sub">No authorizations cover this month.</p> : null}
        {rows.length > 0 ? (
          <div className="space-y-3 rounded-og border border-og-line bg-og-card p-3">
            {/* The summary line: the key figures and every warning stay visible whether the section is open or folded. */}
            <dl className="flex flex-wrap gap-x-8 gap-y-2" data-testid="hours-summary">
              <Stat label="Worked" value={workedLabel} />
              <Stat label="Hours left" value={hoursLabel(leftTotal)} />
              {overLimit > 0 ? <Stat label="Over limit" value={hoursLabel(overLimit)} tone="red" /> : null}
            </dl>
            {tierSummary ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="authorization-tiers">
                {tierSummary}. <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to="/service-verification/reports?view=reconciliation" data-testid="authorization-tiers-link">See which clients</Link>
              </p>
            ) : null}
            {sum(rows, "needsReconciliationMinutes") > 0 ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="needs-reconciliation">
                {hoursLabel(sum(rows, "needsReconciliationMinutes"))} are reserved on shifts that ended with no visit record, until a person decides. <Link className="underline [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:items-center" to="/schedule">Reconcile shifts</Link>
              </p>
            ) : null}
            {over.length > 0 ? (
              <p role="status" className="text-sm font-semibold text-red-700">
                <span aria-hidden="true">● </span>Over the authorization: {over.map((r) => r.serviceName).join(", ")}. Review before billing.
              </p>
            ) : null}
            {!hoursFolded ? <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-og-line pt-3">
              <Stat label="Authorized" value={hoursLabel(sum(rows, "authorizedMinutes"))} />
              <Stat label="Billable" value={hoursLabel(hasHoursData ? sum(rows, "hoursBillableMinutes") : sum(rows, "billableMinutes"))} />
            </dl> : null}
            {!hoursFolded && chartData.length > 0 ? <Chart title="Worked hours by service" data={chartData} shape="parts-of-whole" unit="worked hours" total={workedLabel} /> : null}
            {!hoursFolded ? <Disclosure summary="Hours by service, and how these are calculated">
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Hours by service (scrolls sideways on small screens)">
                <table className="w-full min-w-[820px] border-collapse text-sm">
                  <caption className="sr-only">Hours by service for the selected month</caption>
                  <thead>
                    <tr className="border-b border-og-line text-left text-xs font-semibold text-og-sub">
                      <th scope="col" className="py-2 pr-3">Service</th>
                      <th scope="col" className="px-3 py-2 text-right">Authorized</th>
                      <th scope="col" className="px-3 py-2 text-right">Billable</th>
                      <th scope="col" className="px-3 py-2 text-right">Rounding</th>
                      <th scope="col" className="px-3 py-2 text-right">Pending</th>
                      <th scope="col" className="px-3 py-2 text-right">Reserved</th>
                      <th scope="col" className="px-3 py-2 text-right">Hours left</th>
                      <th scope="col" className="px-3 py-2 text-right">Over limit</th>
                      <th scope="col" className="px-3 py-2 text-right">Worked</th>
                      <th scope="col" className="px-3 py-2 text-right">Worked, not billable</th>
                      <th scope="col" className="py-2 pl-3 text-right">Approved</th>
                    </tr>
                  </thead>
                  <tbody className="font-og-mono tabular-nums text-og-ink">
                    {rows.map((r) => (
                      <tr key={r.serviceId} className="border-b border-og-line last:border-0">
                        <th scope="row" className="py-2 pr-3 text-left font-sans font-semibold">{r.serviceName} <span className="font-normal text-og-sub">({r.serviceCode} · {r.clientCount} {r.clientCount === 1 ? "client" : "clients"})</span></th>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.authorizedMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(hasHoursData ? r.hoursBillableMinutes : r.billableMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.hoursRoundingMinutes ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(hasHoursData ? r.hoursPendingMinutes : r.reviewMinutes)}</td>
                        <td className={`px-3 py-2 text-right ${(r.needsReconciliationMinutes ?? 0) > 0 ? "font-semibold text-amber-900" : ""}`}>{hoursLabel(hasHoursData ? r.hoursReservedMinutes : (r.reservedMinutes ?? r.scheduledMinutes))}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(hasHoursData ? r.hoursLeftMinutes : r.remainingMinutes)}</td>
                        <td className={`px-3 py-2 text-right ${(hasHoursData ? r.hoursOverLimitMinutes : r.overLimitMinutes) ? "font-semibold text-red-700" : ""}`}>{hoursLabel(hasHoursData ? r.hoursOverLimitMinutes : r.overLimitMinutes)}</td>
                        <td className="px-3 py-2 text-right">{hoursLabel(r.workedMinutes)}</td>
                        <td className={`px-3 py-2 text-right ${(r.hoursWorkedNotBillableMinutes ?? 0) > 0 ? "font-semibold text-amber-900" : ""}`}>{hoursLabel(r.hoursWorkedNotBillableMinutes ?? 0)}</td>
                        <td className="py-2 pl-3 text-right">{hoursLabel(r.approvedMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2">{HOURS_EQUATION_TEXT}</p>
              <p className="mt-1">Across authorizations: Authorized − Billable − Rounding − Pending − Reserved = Hours left − Over limit. {HOURS_TOTAL_NOTE}</p>
              <p className="mt-1">Billable is confirmed time. Pending is {HOURS_DEFINITIONS.pending.charAt(0).toLowerCase()}{HOURS_DEFINITIONS.pending.slice(1)} Reserved is {HOURS_DEFINITIONS.reserved.charAt(0).toLowerCase()}{HOURS_DEFINITIONS.reserved.slice(1)} Rounding is shown only when an approved adjustment exists.</p>
              <p className="mt-1">Worked, not billable is outside the equation: time worked beyond what counts as Billable or Pending (the billing cap, or a review closed as not billable). It is shown so no worked time is hidden.</p>
              <p className="mt-1">Healthy is below 80% committed, Near Limit 80% to below 95%, Critical 95% and above. An amended authorization counts once (its latest version).</p>
              <p className="mt-1">Billable means confirmed. Approved means a person approved it for billing. Neither means submitted or paid.</p>
              <p className="mt-1"><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=reconciliation">Monthly reconciliation by client and authorization</Link></p>
            </Disclosure> : null}
          </div>
        ) : null}
      </section>

      {isOwnerFinance && finance.showSection ? (
        <section aria-labelledby="finance-heading" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 id="finance-heading" className="text-lg font-bold text-og-ink">Financial impact</h2>
            <CollapseButton collapsed={financeFolded} onToggle={toggleFinance} label="the figures" />
          </div>
          <div className="space-y-3 rounded-og border border-og-line bg-og-card p-3">
            {billable ? (
              <dl data-testid="finance-summary">
                <dt className="text-xs font-medium text-og-sub">{billable.label}</dt>
                {billable.value ? <dd className="font-og-mono text-lg font-semibold tabular-nums text-og-ink">{billable.value}</dd> : <dd className="text-sm text-og-sub">{billable.empty ?? "Not calculated"}</dd>}
              </dl>
            ) : null}
            {finance.missingRates > 0 ? (
              <p role="status" className="flex flex-wrap items-center gap-x-3 text-sm text-amber-900" data-testid="missing-rate-message">
                <span><span aria-hidden="true">▲ </span>{finance.missingRates} {finance.missingRates === 1 ? "authorization has" : "authorizations have"} no hourly rate, so {finance.missingRates === 1 ? "its" : "their"} hours are left out of these values.</span>
                <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to={`/authorizations/rates?month=${month}`}>Review authorizations</Link>
              </p>
            ) : null}
            {!financeFolded ? <>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-og-line pt-3 sm:grid-cols-2">
                {finance.items.slice(1).map((i) => (
                  <div key={i.key}>
                    <dt className="text-xs font-medium text-og-sub">{i.label}</dt>
                    {i.value ? <dd className="font-og-mono text-lg font-semibold tabular-nums text-og-ink">{i.value}</dd> : i.empty ? <dd className="text-sm text-og-sub">{i.empty}</dd> : <dd className="text-sm text-og-sub">Not calculated</dd>}
                  </div>
                ))}
              </dl>
              <Disclosure summary="What these values mean">
                <p>Billable value is billable hours × the authorization rate. It is not collected revenue.</p>
                <p className="mt-1">Approved for billing is fixed when a person approves it. Approved is not submitted or paid.</p>
                <p className="mt-1">Unused hours are hours left × the rate: potential revenue not realized, not a loss.</p>
                <p className="mt-1">Caregiver cost and margin are not shown because Ogevia has no caregiver pay data.</p>
              </Disclosure>
            </> : null}
          </div>
        </section>
      ) : null}

      <ContinuityStatusCard />
    </div>
  );
}
