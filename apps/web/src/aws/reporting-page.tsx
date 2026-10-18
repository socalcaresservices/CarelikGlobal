import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { formatDuration, formatNumericDate, formatClockTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { agencyMonth, useAgencyClock } from "./agency-clock";
import { useAwsApi } from "./aws-workspace";
import type { ChainRow } from "./monthly-chain-report";
import { saveCsv } from "./save-csv";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";

interface Performance {
  monthStart: string; monthEnd: string;
  counts: { shifts: number; coveredNow: number; uncoveredNow: number; callOuts: number; cancelled: number; noShow: number; endedWithoutRecord: number };
  utilization: { authorizedMinutes: number; committedMinutes: number; percent: number | null };
  missedVisits: null; missedVisitsNote: string; cancellationNote: string; noShowNote: string;
}
interface AuditReport { total: number; limit: number; offset: number; events: Array<{ occurredAt: string; action: string; actorName: string | null; entityType: string; reason: string | null; fields: string[] }>; note: string }

const sum = (rows: ChainRow[], k: keyof ChainRow) => rows.reduce((t, r) => t + Number(r[k] ?? 0), 0);
const unavailable = (what: string) => <p role="status" className="text-sm text-red-700">{what} could not be loaded. It is shown as unavailable, not as zero.</p>;

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className="space-y-2">
      <div><h2 id={`${id}-h`} className="text-lg font-bold text-og-ink">{title}</h2><p className="text-sm text-og-sub">{lead}</p></div>
      {children}
    </section>
  );
}
const Fig = ({ label, value, tone }: { label: string; value: string | number; tone?: "red" | undefined }) => (
  <div><dt className="text-xs text-og-sub">{label}</dt><dd className={`font-og-mono text-xl font-semibold tabular-nums ${tone === "red" ? "text-red-700" : "text-og-ink"}`}>{value}</dd></div>
);

/** One area for the five Board 5 sections. Every figure comes from a server report; nothing here recalculates. */
export function ReportingPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { tz, today } = useAgencyClock();
  const [month, setMonth] = useState(() => agencyMonth(tz));
  const monthStart = `${month}-01`;
  const valid = /^\d{4}-\d{2}$/.test(month);
  const canBill = hasPermission("billing.visits.read");
  const canExport = hasPermission("reports.export");
  const isOwner = hasPermission("organization.update");
  const enabled = !!activeOrganizationId && valid;
  const chain = useQuery({ queryKey: ["monthly-chain", activeOrganizationId, monthStart], enabled: enabled && hasPermission("visits.read"),
    queryFn: async () => (await api.get<{ rows: ChainRow[] }>("/v1/reports/monthly-chain", { organizationId: activeOrganizationId, monthStart })).rows });
  const perf = useQuery({ queryKey: ["agency-performance", activeOrganizationId, monthStart], enabled: enabled && (hasPermission("shifts.manage") || hasPermission("visits.manage")),
    queryFn: async () => (await api.get<{ performance: Performance }>("/v1/reports/agency-performance", { organizationId: activeOrganizationId, monthStart })).performance });
  const rows = chain.data ?? [];
  const [exp, setExp] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  async function exportReport(report: "billing_review" | "audit_report", params: Record<string, unknown>) {
    if (exp.busy) return;
    setExp({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ filename: string; csv: string; rowCount: number }>("/v1/exports", { organizationId: activeOrganizationId, report, params });
      saveCsv(r.filename, r.csv);
      setExp({ busy: false, error: null, done: `The server generated ${r.filename} (${r.rowCount} row${r.rowCount === 1 ? "" : "s"}) and recorded the export. Whether it reached this device is not recorded.` });
      await queryClient.invalidateQueries({ queryKey: ["report-exports"] });
    } catch (cause) {
      setExp({ busy: false, error: cause instanceof Error ? cause.message : "The export was not made. Nothing was downloaded.", done: null });
    }
  }
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Reporting & billing" lead="Billing readiness, authorized against delivered hours, agency performance, reports and exports, and audit evidence in one place."
        action={<label className="text-xs font-semibold text-og-sub">Month<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 block min-h-[40px] rounded-lg border border-og-line bg-og-card px-3 text-sm text-og-ink" /></label>} />

      <Section id="billing-readiness" title="Billing readiness" lead="Visits by billing state for the month. Approval is a person's decision and is not submission or payment.">
        {!hasPermission("visits.read") ? <p className="text-sm text-og-sub">Your role does not include this section.</p> : chain.isError ? unavailable("Billing readiness") : chain.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : (
          <Card className="space-y-2 p-4" data-testid="billing-readiness">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-5">
              <Fig label="Needs correction" value={sum(rows, "needsCorrectionVisits")} />
              <Fig label="Waiting for client" value={sum(rows, "waitingVisits")} />
              {canBill ? <Fig label="Ready for review" value={sum(rows, "readyForReviewVisits")} /> : null}
              {canBill ? <Fig label="Approved for billing" value={sum(rows, "approvedVisits")} /> : null}
              {canBill ? <Fig label="Voided approvals" value={sum(rows, "voidedApprovals")} /> : null}
            </dl>
            {!canBill ? <p className="text-xs text-og-sub">Ready-for-review and approved counts need billing access.</p> : null}
            <p className="text-xs text-og-sub">“Reviewed, not billable” visits are a separate outcome ({formatDuration(sum(rows, "reviewedNotBillableMinutes"))}) and are never counted as ready or approved. There is no submitted or billed state.</p>
            {canBill ? <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to="/billing-review">Open billing review</Link> : null}
          </Card>
        )}
      </Section>

      <Section id="authorized-delivered" title="Authorized vs delivered hours" lead="Worked, confirmed and billable are different things; reserved time is counted once. Over-limit time is shown, never hidden.">
        {!hasPermission("visits.read") ? null : chain.isError ? unavailable("Authorized and delivered hours") : chain.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : (
          <Card className="space-y-2 p-4" data-testid="authorized-delivered">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              <Fig label="Authorized" value={formatDuration(sum(rows, "authorizedMinutes"))} />
              <Fig label="Reserved" value={formatDuration(sum(rows, "reservedMinutes"))} />
              <Fig label="Worked" value={formatDuration(sum(rows, "workedMinutes"))} />
              <Fig label="Confirmed" value={formatDuration(sum(rows, "confirmedMinutes"))} />
              <Fig label="Billable" value={formatDuration(sum(rows, "billableMinutes"))} />
              <Fig label="Committed" value={formatDuration(sum(rows, "committedMinutes"))} />
              <Fig label="Left (signed)" value={formatDuration(sum(rows, "remainingMinutes"))} />
              {sum(rows, "overLimitMinutes") > 0 ? <Fig label="Over the limit" value={formatDuration(sum(rows, "overLimitMinutes"))} tone="red" /> : null}
            </dl>
            {rows.some((r) => !r.reservedOk || r.visitsOk === false || !r.balanceOk) ? <p role="status" className="text-sm font-semibold text-amber-900">A check on the full-chain report did not add up. Open it to see the difference.</p> : null}
            <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to="/service-verification/reports?view=reconciliation">Full chain by client and authorization</Link>
          </Card>
        )}
      </Section>

      <Section id="agency-performance" title="Agency performance" lead="Counts of what is recorded, each with its definition. A missed-visits figure is not published.">
        {!(hasPermission("shifts.manage") || hasPermission("visits.manage")) ? <p className="text-sm text-og-sub">Your role does not include this section.</p> : perf.isError ? unavailable("Agency performance") : perf.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : perf.data ? (
          <Card className="space-y-2 p-4" data-testid="agency-performance">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              <Fig label="Shifts this month" value={perf.data.counts.shifts} />
              <Fig label="Uncovered, still to come" value={perf.data.counts.uncoveredNow} tone={perf.data.counts.uncoveredNow ? "red" : undefined} />
              <Fig label="Call-outs" value={perf.data.counts.callOuts} />
              <Fig label="Cancelled" value={perf.data.counts.cancelled} />
              <Fig label="No-show" value={perf.data.counts.noShow} />
              <Fig label="Ended, no visit record" value={perf.data.counts.endedWithoutRecord} />
              <Fig label="Utilization" value={perf.data.utilization.percent === null ? "Not available" : `${perf.data.utilization.percent}%`} />
              <div><dt className="text-xs text-og-sub">Missed visits</dt><dd data-testid="missed-visits" className="text-sm font-semibold text-og-ink">Not published</dd></div>
            </dl>
            <Disclosure summary="Definitions and what is not measured">
              <p>Shifts are counted by their start date in the agency&apos;s time zone. Uncovered means a scheduled shift that has not ended and has no caregiver, including one whose caregiver called out.</p>
              <p className="mt-1">Utilization is committed time (billable + approved rounding adjustments + reserved) divided by authorized time, rounded down.</p>
              <p className="mt-1" data-testid="missed-note">{perf.data.missedVisitsNote}</p>
              <p className="mt-1">{perf.data.cancellationNote}</p>
              <p className="mt-1">{perf.data.noShowNote}</p>
              <p className="mt-1">“Ended, no visit record” is the list on Schedule and Home waiting for a person to decide what happened. It does not say the caregiver failed to go.</p>
            </Disclosure>
          </Card>
        ) : null}
      </Section>

      <Section id="reports-exports" title="Reports and exports" lead="Every export is made by the server and recorded. The record shows the file was generated, not that it was saved.">
        <Card className="space-y-2 p-4">
          <ul className="space-y-1 text-sm">
            <li><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=overview">Reports overview</Link></li>
            <li><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=calendar">Client monthly calendar</Link></li>
            <li><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=reconciliation">Monthly hours and billing (full chain)</Link></li>
            <li><Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=corrections">Correction history</Link></li>
          </ul>
          {canExport && canBill ? <Button type="button" variant="secondary" className="min-h-11" loading={exp.busy} disabled={exp.busy || !valid} onClick={() => void exportReport("billing_review", { monthStart })}>Export billing review (CSV, server-made, recorded)</Button> : null}
          {!canExport ? <p className="text-xs text-og-sub">Your role can read these reports but not export them.</p> : null}
          {exp.error ? <p role="alert" className="text-sm text-red-700">{exp.error}</p> : null}
          {exp.done ? <p role="status" className="text-sm text-emerald-800">{exp.done}</p> : null}
        </Card>
      </Section>

      <Section id="audit-evidence" title="Compliance and audit evidence" lead="Corrections, supporting records and the audit trail. The audit report is for the agency owner.">
        <Card className="space-y-2 p-4">
          <Link className="font-semibold text-og-link underline" to="/service-verification/reports?view=corrections">Correction history and supporting records</Link>
          {isOwner ? <AuditReportPanel today={today} canExport={canExport} onExport={(p) => exportReport("audit_report", p)} busy={exp.busy} /> : <p className="text-sm text-og-sub">The audit report is available to the agency owner.</p>}
        </Card>
      </Section>
    </div>
  );
}

function AuditReportPanel({ today, canExport, onExport, busy }: { today: string; canExport: boolean; onExport: (p: Record<string, unknown>) => void; busy: boolean }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const back = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(back(7));
  const [to, setTo] = useState(today);
  const [prefix, setPrefix] = useState("");
  const [page, setPage] = useState(0);
  const okRange = from <= to;
  const q = useQuery({
    queryKey: ["audit-report", activeOrganizationId, from, to, prefix, page], enabled: !!activeOrganizationId && okRange,
    queryFn: async () => (await api.get<{ report: AuditReport }>("/v1/reports/audit", { organizationId: activeOrganizationId, dateFrom: from, dateTo: to, ...(prefix.trim() ? { actionPrefix: prefix.trim() } : {}), limit: "25", offset: String(page * 25) })).report,
  });
  return (
    <div className="space-y-2" data-testid="audit-report">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-xs font-medium text-og-sub">From<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className="mt-1 block min-h-11 w-full rounded-lg border border-og-line bg-og-card px-2 text-sm text-og-ink" /></label>
        <label className="text-xs font-medium text-og-sub">To<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className="mt-1 block min-h-11 w-full rounded-lg border border-og-line bg-og-card px-2 text-sm text-og-ink" /></label>
        <label className="col-span-2 text-xs font-medium text-og-sub">Action starts with (optional)<input value={prefix} placeholder="client." onChange={(e) => { setPrefix(e.target.value.toLowerCase()); setPage(0); }} className="mt-1 block min-h-11 w-full rounded-lg border border-og-line bg-og-card px-2 text-sm text-og-ink" /></label>
      </div>
      {!okRange ? <p role="alert" className="text-sm text-red-700">The start date must not be after the end date.</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">The audit report could not be loaded. {(q.error as Error).message}</p> : null}
      {q.data ? (
        <>
          <p className="text-sm text-og-ink">{q.data.total} event{q.data.total === 1 ? "" : "s"} · showing {q.data.events.length}</p>
          <ul className="space-y-1 text-sm">
            {q.data.events.map((e, n) => <li key={n} className="text-og-ink" data-testid="audit-event">{formatNumericDate(e.occurredAt)} {formatClockTime(e.occurredAt)} · {e.action.replace(/[._]/g, " ")}{e.actorName ? ` · ${e.actorName}` : ""} · {e.entityType.replace(/_/g, " ")}{e.fields.length ? ` · changed: ${e.fields.join(", ").replace(/_/g, " ")}` : ""}{e.reason ? ` · ${e.reason}` : ""}</li>)}
          </ul>
          <p className="text-xs text-og-sub">{q.data.note}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" className="min-h-11" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button type="button" variant="secondary" className="min-h-11" disabled={(page + 1) * 25 >= q.data.total} onClick={() => setPage(page + 1)}>Next</Button>
            {canExport ? <Button type="button" variant="secondary" className="min-h-11" loading={busy} disabled={busy || !okRange} onClick={() => onExport({ dateFrom: from, dateTo: to, ...(prefix.trim() ? { actionPrefix: prefix.trim() } : {}) })}>Export audit report (CSV, server-made, recorded)</Button> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
