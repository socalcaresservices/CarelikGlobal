import { BusinessComplianceTile } from "./business-compliance-page";
import { HOURS_DEFINITIONS, HOURS_EQUATION_TEXT, HOURS_TOTAL_NOTE } from "@/lib/hours-accounting";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useDashboardAppearance, type DashboardChartStyle } from "./appearance/appearance-hooks";
import { Link } from "react-router-dom";
import { ContinuityStatusCard } from "./continuity-page";
import { useOrganization } from "@/providers/organization-provider";
import { streams, TONE, useAttentionOverview, type Stream } from "./attention";
import { hoursLabel, moneyLabel, useAwsApi, useUtilisation, type UtilisationRow } from "./aws-workspace";
import { financeView } from "./finance-view";
import { Chart } from "./ui/chart";
import { CollapseButton, QuickActions, RefreshStatus, TodaysVisits, TopIssues } from "./home-extras";
import { useCollapsed, useHomeIssues } from "./home-data";
import { agencyMonth, useAgencyClock } from "./agency-clock";
import { Disclosure } from "./ui/disclosure";
import { CompactAlert } from "./ui/compact-alert";
import { linkClass } from "./ui-classes";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";
import { InfoTip } from "./ui/info-tip";

const sum = (rows: UtilisationRow[], key: keyof UtilisationRow) => rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);

/** Zero-state sentences ("Nothing overdue...") are not worth a line on a compact tile: the zero and the unit already say it. */
type DashboardDatum = { label: string; value: number; display: string };

/** Divide each area in proportion to the values, alternating the split axis. */
function treemap(data: DashboardDatum[], x = 0, y = 0, w = 100, h = 100): { row: DashboardDatum; x: number; y: number; w: number; h: number }[] {
  if (data.length < 2) return data.map((row) => ({ row, x, y, w, h }));
  const [first, ...rest] = data;
  if (!first) return [];
  const ratio = first.value / data.reduce((sum, row) => sum + row.value, 0);
  return w >= h
    ? [{ row: first, x, y, w: w * ratio, h }, ...treemap(rest, x + w * ratio, y, w * (1 - ratio), h)]
    : [{ row: first, x, y, w, h: h * ratio }, ...treemap(rest, x, y + h * ratio, w, h * (1 - ratio))];
}
function DashboardVisual({ title, data, style, current, colors }: {
  title: string; data: DashboardDatum[]; style: DashboardChartStyle; current: "segmented" | "bar"; colors: readonly string[];
}) {
  const mode = style === "current" ? current : style;
  const total = data.reduce((acc, row) => acc + Math.max(0, row.value), 0);
  const max = Math.max(1, ...data.map((row) => row.value));
  let angle = 0;
  const stops = data.map((row, index) => {
    const start = angle;
    angle += total ? Math.max(0, row.value) / total * 360 : 0;
    return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
  });
  return <figure aria-label={title} className="space-y-2">
    {total > 0 && mode === "treemap" ? <div aria-hidden="true" className="relative h-24 overflow-hidden rounded-xl">
      {treemap(data.filter((row) => row.value > 0)).map(({ row, x, y, w, h }) =>
        <div key={row.label} className="absolute rounded-md border-2 border-og-card" style={{
          left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`, backgroundColor: colors[data.indexOf(row) % colors.length],
        }} />)}
    </div> : null}
    {total > 0 && mode === "pie" ? <div aria-hidden="true" className="mx-auto h-28 w-28 rounded-full ring-2 ring-og-card"
      style={{ background: `conic-gradient(${stops.join(", ")})` }} /> : null}
    {total > 0 && mode === "segmented" ? <div aria-hidden="true" className="flex h-5 overflow-hidden rounded-full">
      {data.map((row, i) => <div key={row.label} style={{ width: `${Math.max(0, row.value) / total * 100}%`, backgroundColor: colors[i % colors.length] }} />)}
    </div> : null}
    <ul className="space-y-2 text-sm">
      {data.map((row, i) => <li key={row.label}>
        <div className="flex justify-between gap-2"><span><span aria-hidden="true" className="mr-2 inline-block h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: colors[i % colors.length] }} />{row.label}</span><strong className="shrink-0">{row.display}</strong></div>
        {mode === "bar" ? <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-og-line/60">
          <div className="h-full rounded-full" style={{ width: `${Math.max(0, row.value) / max * 100}%`, backgroundColor: colors[i % colors.length] }} />
        </div> : null}
      </li>)}
    </ul>
  </figure>;
}
const QUIET = /^(Nothing|Every)\b/;

interface ExpiringAuthorization {
  clientId: string; clientCode: string; serviceName: string; endsOn: string;
  daysLeft: number; availableMinutes: number; estimatedCents: number | string | null;
}

function ExpiringHours({ showMoney }: { showMoney: boolean }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const query = useQuery({
    queryKey: ["aws-utilisation", activeOrganizationId, "expiring"],
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
    queryFn: async () => {
      const result = await api.get<{ expiring?: ExpiringAuthorization[] }>("/v1/reports/utilisation",
        { organizationId: activeOrganizationId, expiring: "true" });
      if (!Array.isArray(result.expiring)) throw new Error("Expiring hours were not returned.");
      return result.expiring;
    },
  });
  if (!hasPermission("visits.read")) return null;
  const expiring = query.data ?? [];
  return <section aria-label="Hours expiring soon" className="space-y-2 rounded-og border border-og-line bg-og-card p-3">
    <div className="flex items-center gap-2"><h2 className="font-semibold">Hours expiring soon</h2>
      <InfoTip label="About expiring hours">Available hours in the month the authorization ends. The dollar estimate uses rates on file.</InfoTip></div>
    {query.isLoading ? <p className="text-sm">Loading expiring hours…</p> : null}
    {query.isError ? <p role="alert" className="text-sm text-red-700">Could not load expiring hours. <button aria-label="Retry expiring hours" className="underline" onClick={() => void query.refetch()}>Retry</button></p> : null}
    {query.data?.length === 0 ? <p className="text-sm text-og-sub">No available hours expire in the next 30 days.</p> : null}
    {query.data?.length ? <div className="grid gap-2 sm:grid-cols-3">
      {([[0, 7], [8, 14], [15, 30]] as const).map(([min, max]) => {
        const rows = expiring.filter((r) => r.daysLeft >= min && r.daysLeft <= max);
        const minutes = rows.reduce((total, r) => total + Number(r.availableMinutes), 0);
        const rated = rows.filter((r) => r.estimatedCents != null);
        return <details key={min} className="rounded border border-og-line p-2">
          <summary className="cursor-pointer font-medium">{min}–{max} days · {hoursLabel(minutes)}</summary>
          {showMoney && rated.length ? <p className="text-sm">Estimated value {moneyLabel(rated.reduce((total, r) => total + Number(r.estimatedCents), 0))}</p> : null}
          {showMoney && rated.length < rows.length ? <p className="text-sm">Some hours have no rate.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">{rows.map((r, i) => <li key={i}>
            <Link className="underline" to={`/service-verification/reports?${new URLSearchParams({ view: "reconciliation", client: r.clientId, month: r.endsOn.slice(0, 7) })}`}>{r.clientCode}</Link> · {r.serviceName} · {hoursLabel(r.availableMinutes)} · {r.endsOn}
          </li>)}</ul>
        </details>;
      })}
    </div> : null}
  </section>;
}
function Tile({ s, unavailable = false }: { s: Stream; unavailable?: boolean }) {
  const t = TONE[s.tone];
  const hot = s.tone !== "neutral";
  const showDetail = !(s.count === 0 && QUIET.test(s.detail));
  return (
    <li>
      <Link
        to={s.to}
        data-testid={`stream-${s.key}`}
        title={showDetail ? s.detail : undefined}
        className={`flex h-full min-h-[44px] md:min-h-[36px] flex-wrap items-center gap-x-2 gap-y-0 rounded-og border bg-og-card px-2.5 py-1 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link [@media(pointer:coarse)]:min-h-[44px] ${s.tone === "red" ? "border-red-700" : s.tone === "amber" ? "border-amber-600" : "border-og-line"}`}
      >
        <span className="text-sm font-semibold text-og-ink">{s.label}</span>
        <span className="ml-auto whitespace-nowrap">
          {unavailable ? <span className="text-sm font-semibold text-og-sub" data-testid={`stream-${s.key}-unavailable`}>Unavailable</span> : <>
            <span className="font-og-mono text-base font-semibold tabular-nums text-og-ink">{s.count}</span>
            <span className="ml-1 text-xs text-og-sub">{s.unit}</span></>}
        </span>
        {hot && !unavailable ? <StatusChip tone={s.tone}>{s.word ?? t.word}</StatusChip> : null}
        {showDetail ? <span className="sr-only">{s.detail}</span> : null}
      </Link>
    </li>
  );
}

/** The fifth figure of the row: hours still available this month. Unavailable (never 0) when the hours could not be loaded. */
function HoursTile({ failed, loading, left }: { failed: boolean; loading: boolean; left: string | null }) {
  if (loading || (!failed && left === null)) return null;
  return (
    <li>
      <Link to="/reporting" data-testid="stream-hours" className="flex h-full min-h-[44px] md:min-h-[36px] flex-wrap items-center gap-x-2 gap-y-0 rounded-og border border-og-line bg-og-card px-2.5 py-1 hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:min-h-[44px]">
        <span className="text-sm font-semibold text-og-ink">Hours left</span>
        <span className="ml-auto whitespace-nowrap">
          {failed ? <span className="text-sm font-semibold text-og-sub" data-testid="stream-hours-unavailable">Unavailable</span> : <span className="font-og-mono text-base font-semibold tabular-nums text-og-ink">{left}</span>}
        </span>
      </Link>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs font-medium text-og-sub">{label}</dt>
      <dd className={`font-og-mono text-sm font-semibold tabular-nums ${tone === "red" ? "text-red-700" : "text-og-ink"}`}>{tone === "red" ? <span aria-hidden="true">● </span> : null}{value}</dd>
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
  const { chartStyle, colors } = useDashboardAppearance();
  const [month, setMonth] = useState(() => agencyMonth(tz)); // the AGENCY's month, not the browser's (F7)
  const overview = useAttentionOverview();
  // The attention tile and the work list are two requests. When the list fails the tile cannot be trusted to agree with it, so it reads Unavailable, never 0.
  const issues = useHomeIssues();
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
  const remainingByService = rows.map((row) => ({
    label: row.serviceName,
    value: Math.max(0, Number(row.hoursLeftMinutes ?? row.remainingMinutes ?? 0)),
  })).filter((row) => row.value > 0);
  const availableMinutes = remainingByService.reduce((total, row) => total + row.value, 0);
  const moneyBars = ([
    ["Approved for billing", "approvedValueCents"],
    ["Potential value of unused hours", "unusedValueCents"],
  ] as const).flatMap(([label, key]) => {
    const rated = rows.filter((row) => row[key] != null);
    return rated.length ? [{ label, cents: sum(rated, key) }] : [];
  });
  return (
    <div className="space-y-3">
      <PageHeader
        title="Dashboard"
        action={
          <label className="flex items-center gap-2 text-xs font-semibold text-og-sub">
            Month
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="block min-h-[44px] md:min-h-[32px] rounded-md border border-og-line bg-og-card px-2 text-sm text-og-ink [@media(pointer:coarse)]:min-h-[44px]" />
          </label>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0">
        <QuickActions />
        <RefreshStatus overview={overview.data} loading={overview.isLoading} failed={overview.isError || issues.isError} refreshing={overview.isFetching || utilisation.isFetching} onRefresh={refresh} />
      </div>

      <section aria-label="What needs attention">
        {overview.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {tiles.length > 0 || utilisation.isError || rows.length > 0 ? (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-5" data-testid="kpi-row">
            {tiles.filter((s) => s.key !== "now").map((s) => <Tile key={s.key} s={s} />)}
            <HoursTile failed={utilisation.isError} loading={utilisation.isLoading} left={rows.length > 0 ? hoursLabel(leftTotal) : null} />
          </ul>
        ) : null}
      </section>

      <TopIssues />
      <BusinessComplianceTile />
      <TodaysVisits />
      <ExpiringHours showMoney={isOwnerFinance} />

      {rows.length > 0 ? <section aria-label="Hours and money to watch" className={`grid gap-3 lg:grid-cols-2 ${isOwnerFinance ? "xl:grid-cols-3" : ""}`}>
        <Link className="text-xs font-semibold text-og-link underline col-span-full" to="/settings/appearance">Chart appearance</Link>
        <article className="space-y-2 rounded-og border border-og-line bg-og-card p-4">
          <h2 className="text-lg font-bold text-og-ink">Hours available to schedule</h2>
          <p className="text-2xl font-bold tabular-nums text-og-ink">{hoursLabel(availableMinutes)}</p>
          <InfoTip label="About these figures">Hours still available in the selected month. Pending and reserved hours are already accounted for.</InfoTip>
          {remainingByService.length > 0 ? <DashboardVisual title="Unused hours by service" style={chartStyle} colors={colors} current="segmented"
            data={remainingByService.map((row) => ({ ...row, display: hoursLabel(row.value) }))} /> : null}
          <p className="text-sm text-og-sub">{ending} {ending === 1 ? "authorization ends" : "authorizations end"} within 30 days. Review end dates to see which unused hours may expire.</p>
          <Link className={linkClass} to="/service-verification/reports?view=reconciliation">Review client authorizations</Link>
        </article>
        {isOwnerFinance ? <article className="space-y-2 rounded-og border border-og-line bg-og-card p-4">
          <h2 className="text-lg font-bold text-og-ink">Billing and potential value</h2>
          <DashboardVisual title="Approved billing and potential unused value" style={chartStyle} colors={colors} current="bar"
            data={moneyBars.map(({ label, cents }) => ({ label, value: cents, display: moneyLabel(cents) ?? "Unavailable" }))} />
          {moneyBars.length < 2 ? <p className="text-sm text-og-sub">Only available dollar amounts are shown.</p> : null}
          <InfoTip label="About these figures">Unused value is an estimate based on recorded rates. Approved billing does not show payment received.</InfoTip>
          {finance.missingRates > 0 ? <p className="text-sm text-amber-900">{finance.missingRates} authorizations lack a rate. The estimate may be incomplete.</p> : null}
        </article> : null}
        <article className="space-y-3 rounded-og border border-og-line bg-og-card p-4">
          <h2 className="text-lg font-bold text-og-ink">Worked vs authorized hours</h2>
          <p className="text-sm font-semibold tabular-nums text-og-ink">{workedLabel} worked · {hoursLabel(sum(rows, "authorizedMinutes"))} authorized</p>
          <InfoTip label="About these figures">Compare services for the selected month. Hours not yet worked may already be reserved for upcoming shifts.</InfoTip>
          <figure aria-label="Worked and authorized hours by service">
            <ul className="space-y-3">
              {rows.map((row) => {
                const authorized = Number(row.authorizedMinutes ?? 0);
                const worked = Number(row.workedMinutes ?? 0);
                const scale = Math.max(1, authorized, worked);
                return <li key={row.serviceId} className="space-y-1 border-t border-og-line pt-2 text-sm">
                  <p className="font-semibold">{row.serviceName}</p>
                  <div className="flex flex-wrap justify-between gap-x-2 text-xs tabular-nums">
                    <span>Worked {hoursLabel(worked)}</span>
                    <span>Authorized {hoursLabel(authorized)}</span>
                  </div>
                  <div aria-hidden="true" className="space-y-1">
                    <div className="h-2 rounded-full" style={{ width: `${worked / scale * 100}%`, backgroundColor: colors[0] }} />
                    <div className="h-2 rounded-full opacity-40" style={{ width: `${authorized / scale * 100}%`, backgroundColor: colors[1] }} />
                  </div>
                  <p className="text-xs text-og-sub">{authorized === 0 ? "No authorized hours in this month"
                    : worked > authorized ? `${hoursLabel(worked - authorized)} worked above authorized`
                    : `${hoursLabel(authorized - worked)} not yet worked · ${Math.round(worked / authorized * 100)}% worked`}</p>
                </li>;
              })}
            </ul>
          </figure>
        </article>
      </section> : null}

      <details data-testid="hours-billing-detail" className="rounded-og border border-og-line bg-og-card px-3">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-og-ink">Hours, billing and outage readiness</summary>
        <div className="space-y-3 pb-3">
      <section aria-labelledby="util-heading" className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h2 id="util-heading" className="text-sm font-semibold text-og-ink">Hours this month</h2>
          {rows.length > 0 ? <CollapseButton collapsed={hoursFolded} onToggle={toggleHours} label="the hours" /> : null}
        </div>
        {utilisation.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
        {utilisation.isError ? <p role="alert" className="text-sm text-red-700" data-testid="hours-error">The hours could not be loaded. They are not shown as zero. <button type="button" className="font-semibold underline" onClick={() => void utilisation.refetch()}>Retry</button></p> : null}
        {!utilisation.isLoading && !utilisation.isError && rows.length === 0 ? <p className="text-sm text-og-sub">No authorizations cover this month.</p> : null}
        {rows.length > 0 ? (
          <div className="space-y-1.5 rounded-og border border-og-line bg-og-card px-3 py-2">
            {/* The summary line: the key figures and every warning stay visible whether the section is open or folded. */}
            <dl className="flex flex-wrap gap-x-5 gap-y-0.5" data-testid="hours-summary">
              <Stat label="Worked" value={workedLabel} />
              <Stat label="Hours left" value={hoursLabel(leftTotal)} />
              {overLimit > 0 ? <Stat label="Over limit" value={hoursLabel(overLimit)} tone="red" /> : null}
            </dl>
            {tierSummary ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="authorization-tiers">
                {tierSummary}. <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[28px]" to="/service-verification/reports?view=reconciliation" data-testid="authorization-tiers-link">See which clients</Link>
              </p>
            ) : null}
            {sum(rows, "needsReconciliationMinutes") > 0 ? (
              <p role="status" className="text-sm font-semibold text-amber-900" data-testid="needs-reconciliation">
                <span aria-hidden="true">⚠ </span>{hoursLabel(sum(rows, "needsReconciliationMinutes"))} reserved on shifts with no visit record. <Link className="underline [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:items-center" to="/schedule">Reconcile shifts</Link>
              </p>
            ) : null}
            {over.length > 0 ? (
              <p role="status" className="text-sm font-semibold text-red-700">
                <span aria-hidden="true">● </span>Over the authorization: {over.map((r) => r.serviceName).join(", ")}. Review before billing.
              </p>
            ) : null}
            {!hoursFolded ? <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-og-line pt-2">
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
                      <th scope="col" className="py-1 pr-2">Service</th>
                      <th scope="col" className="px-2 py-1 text-right">Authorized</th>
                      <th scope="col" className="px-2 py-1 text-right">Billable</th>
                      <th scope="col" className="px-2 py-1 text-right">Rounding</th>
                      <th scope="col" className="px-2 py-1 text-right">Pending</th>
                      <th scope="col" className="px-2 py-1 text-right">Reserved</th>
                      <th scope="col" className="px-2 py-1 text-right">Hours left</th>
                      <th scope="col" className="px-2 py-1 text-right">Over limit</th>
                      <th scope="col" className="px-2 py-1 text-right">Worked</th>
                      <th scope="col" className="px-2 py-1 text-right">Worked, not billable</th>
                      <th scope="col" className="py-1 pl-2 text-right">Approved</th>
                    </tr>
                  </thead>
                  <tbody className="font-og-mono tabular-nums text-og-ink">
                    {rows.map((r) => (
                      <tr key={r.serviceId} className="border-b border-og-line last:border-0">
                        <th scope="row" className="py-1 pr-2 text-left font-sans font-semibold">{r.serviceName} <span className="font-normal text-og-sub">({r.serviceCode} · {r.clientCount} {r.clientCount === 1 ? "client" : "clients"})</span></th>
                        <td className="px-2 py-1 text-right">{hoursLabel(r.authorizedMinutes)}</td>
                        <td className="px-2 py-1 text-right">{hoursLabel(hasHoursData ? r.hoursBillableMinutes : r.billableMinutes)}</td>
                        <td className="px-2 py-1 text-right">{hoursLabel(r.hoursRoundingMinutes ?? 0)}</td>
                        <td className="px-2 py-1 text-right">{hoursLabel(hasHoursData ? r.hoursPendingMinutes : r.reviewMinutes)}</td>
                        <td className={`px-2 py-1 text-right ${(r.needsReconciliationMinutes ?? 0) > 0 ? "font-semibold text-amber-900" : ""}`}>{hoursLabel(hasHoursData ? r.hoursReservedMinutes : (r.reservedMinutes ?? r.scheduledMinutes))}</td>
                        <td className="px-2 py-1 text-right">{hoursLabel(hasHoursData ? r.hoursLeftMinutes : r.remainingMinutes)}</td>
                        <td className={`px-2 py-1 text-right ${(hasHoursData ? r.hoursOverLimitMinutes : r.overLimitMinutes) ? "font-semibold text-red-700" : ""}`}>{hoursLabel(hasHoursData ? r.hoursOverLimitMinutes : r.overLimitMinutes)}</td>
                        <td className="px-2 py-1 text-right">{hoursLabel(r.workedMinutes)}</td>
                        <td className={`px-2 py-1 text-right ${(r.hoursWorkedNotBillableMinutes ?? 0) > 0 ? "font-semibold text-amber-900" : ""}`}>{hoursLabel(r.hoursWorkedNotBillableMinutes ?? 0)}</td>
                        <td className="py-1 pl-2 text-right">{hoursLabel(r.approvedMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2">{HOURS_EQUATION_TEXT}</p>
              <p className="mt-1">Across authorizations: Authorized − Billable − Rounding − Pending − Reserved = Hours left − Over limit. {HOURS_TOTAL_NOTE}</p>
              <p className="mt-1">Billable is confirmed time. Pending is {HOURS_DEFINITIONS.pending.charAt(0).toLowerCase()}{HOURS_DEFINITIONS.pending.slice(1)} Reserved is {HOURS_DEFINITIONS.reserved.charAt(0).toLowerCase()}{HOURS_DEFINITIONS.reserved.slice(1)} Rounding is shown only when an approved adjustment exists.</p>
              <InfoTip label="Help">Worked, not billable is outside the equation: time worked beyond what counts as Billable or Pending (the billing cap, or a review closed as not billable). It is shown so no worked time is hidden.</InfoTip>
              <InfoTip label="Help">Healthy is below 80% committed, Near Limit 80% to below 95%, Critical 95% and above. An amended authorization counts once (its latest version).</InfoTip>
              <p className="mt-1"><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=reconciliation">Monthly reconciliation by client and authorization</Link></p>
            </Disclosure> : null}
          </div>
        ) : null}
      </section>

      {isOwnerFinance && finance.showSection ? (
        <section aria-labelledby="finance-heading" className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <h2 id="finance-heading" className="text-sm font-semibold text-og-ink">Financial impact</h2>
            <CollapseButton collapsed={financeFolded} onToggle={toggleFinance} label="the figures" />
          </div>
          <div className="space-y-1.5 rounded-og border border-og-line bg-og-card px-3 py-2">
            {billable ? (
              <dl data-testid="finance-summary" className="flex items-baseline gap-2">
                <dt className="text-xs font-medium text-og-sub">{billable.label}</dt>
                {billable.value ? <dd className="font-og-mono text-base font-semibold tabular-nums text-og-ink">{billable.value}</dd> : <dd className="text-sm text-og-sub">{billable.empty ?? "Not calculated"}</dd>}
              </dl>
            ) : null}
            {finance.missingRates > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="missing-rate-message">
                <CompactAlert className="min-w-0 flex-1" summary={`${finance.missingRates} ${finance.missingRates === 1 ? "authorization has" : "authorizations have"} no hourly rate`}>
                  {finance.missingRates === 1 ? "Its" : "Their"} hours are left out of these values.
                </CompactAlert>
                <Link className={linkClass} to={`/authorizations/rates?month=${month}`}>Review authorizations</Link>
              </div>
            ) : null}
            {!financeFolded ? <>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-og-line pt-2 sm:grid-cols-2">
                {finance.items.slice(1).map((i) => (
                  <div key={i.key}>
                    <dt className="text-xs font-medium text-og-sub">{i.label}</dt>
                    {i.value ? <dd className="font-og-mono text-base font-semibold tabular-nums text-og-ink">{i.value}</dd> : i.empty ? <dd className="text-sm text-og-sub">{i.empty}</dd> : <dd className="text-sm text-og-sub">Not calculated</dd>}
                  </div>
                ))}
              </dl>
              <Disclosure summary="What these values mean">
                <InfoTip label="Help">Billable value is billable hours × the authorization rate, not collected revenue. Approved for billing is fixed when a person approves it; it is not submitted or paid.</InfoTip>
                <InfoTip label="Help">Unused hours are hours left × the rate: potential revenue not realized, not a loss. Caregiver cost and margin are not shown (no caregiver pay data).</InfoTip>
              </Disclosure>
            </> : null}
          </div>
        </section>
      ) : null}

      <ContinuityStatusCard />
        </div>
      </details>
    </div>
  );
}
