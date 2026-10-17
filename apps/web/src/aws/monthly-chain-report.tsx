import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export interface ChainRow {
  clientId: string; clientCode: string; serviceId: string; serviceCode: string; serviceName: string; authorizationLineageId: string; authorizationVersion: number | null;
  periodStart: string; periodEnd: string; authorizedMinutes: number;
  scheduledMinutes: number; heldReviewMinutes: number; needsReconciliationMinutes: number; reservedMinutes: number;
  workedMinutes: number; confirmedMinutes: number; billableMinutes: number;
  needsCorrectionMinutes: number; waitingMinutes: number; readyForReviewMinutes: number | null; approvedForBillingMinutes: number | null; reviewedNotBillableMinutes: number;
  humanApprovedMinutes: number | null;
  needsCorrectionVisits: number; waitingVisits: number; readyForReviewVisits: number | null; approvedVisits: number | null; voidedApprovals: number | null;
  adjustmentMinutes: number; committedMinutes: number; remainingMinutes: number; overLimitMinutes: number;
  reservedOk: boolean; visitsOk: boolean | null; balanceOk: boolean; differenceMinutes: number;
}

const m = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatDuration(v));
const signed = (v: number) => (v < 0 ? `−${formatDuration(-v)}` : formatDuration(v));

/**
 * The full chain for one month (0070): authorized, scheduled, held, to reconcile, worked, confirmed, billable, by billing state, approved by a person, with checks that the
 * parts add up. The CSV is made by the server and every export is recorded. "Submitted / billed" is deliberately not here: approval is not submission or payment.
 */
export function MonthlyChainReport({ month }: { month: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canExport = hasPermission("reports.export");
  const monthStart = `${month}-01`;
  const q = useQuery({
    queryKey: ["monthly-chain", activeOrganizationId, monthStart],
    queryFn: async () => (await api.get<{ rows: ChainRow[] }>("/v1/reports/monthly-chain", { organizationId: activeOrganizationId, monthStart })).rows,
    enabled: !!activeOrganizationId && /^\d{4}-\d{2}$/.test(month),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function exportCsv() {
    if (busy) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ exportId: string; filename: string; csv: string }>("/v1/reports/monthly-chain/export", { organizationId: activeOrganizationId, monthStart });
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
      setDone("Exported. The export is recorded with your name and the time.");
      await queryClient.invalidateQueries({ queryKey: ["report-exports"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The export could not be made. Nothing was downloaded.");
    } finally {
      setBusy(false);
    }
  }
  const rows = q.data ?? [];
  const failing = rows.filter((r) => !r.reservedOk || r.visitsOk === false || !r.balanceOk);
  return (
    <Card className="mt-4 space-y-3 p-4 print:border-none print:p-0" data-testid="monthly-chain">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">Full chain for the month</h3>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            One row per client, service and authorization: authorized, scheduled, worked, confirmed, billable, Billing Ready and approved, with checks that the parts add up.
            Approval is not submission or payment.</p>
        </div>
        {canExport ? (
          <Button type="button" variant="secondary" className="min-h-11 print:hidden" disabled={busy || rows.length === 0} loading={busy} onClick={() => void exportCsv()}>Export CSV (recorded)</Button>
        ) : (
          <p className="text-xs text-slate-600 print:hidden">Your role can read this report but not export it.</p>
        )}
      </div>
      {done ? <p role="status" className="text-sm text-emerald-800">{done}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{q.error instanceof Error ? q.error.message : "The report could not be loaded."}</p> : null}
      {q.data && rows.length === 0 ? <p className="text-sm text-slate-600" role="status">No authorization overlaps this month.</p> : null}
      {rows.length > 0 ? (
        failing.length === 0
          ? <p role="status" className="text-sm font-semibold text-emerald-800" data-testid="chain-checks">All checks pass: reserved, visits and authorization add up on every row.</p>
          : <p role="alert" className="text-sm font-semibold text-red-700" data-testid="chain-checks">{failing.length} row{failing.length === 1 ? " does" : "s do"} not add up. The difference is shown on each row; do not rely on those totals.</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Full chain by client and service (scrolls sideways on small screens)">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <caption className="sr-only">Full chain by client, service and authorization for the selected month</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-600">
                <th scope="col" className="py-2 pr-3">Client · service</th>
                <th scope="col" className="px-2 py-2 text-right">Authorized</th>
                <th scope="col" className="px-2 py-2 text-right">Scheduled</th>
                <th scope="col" className="px-2 py-2 text-right">Held (review)</th>
                <th scope="col" className="px-2 py-2 text-right">To reconcile</th>
                <th scope="col" className="px-2 py-2 text-right">Worked</th>
                <th scope="col" className="px-2 py-2 text-right">Confirmed</th>
                <th scope="col" className="px-2 py-2 text-right">Billable</th>
                <th scope="col" className="px-2 py-2 text-right">Needs correction</th>
                <th scope="col" className="px-2 py-2 text-right">Billing Ready</th>
                <th scope="col" className="px-2 py-2 text-right">Approved</th>
                <th scope="col" className="px-2 py-2 text-right">Left</th>
                <th scope="col" className="py-2 pl-2 text-right">Checks</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-slate-900">
              {rows.map((r) => (
                <tr key={r.authorizationLineageId} className="border-b border-slate-100 last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-semibold">Client {r.clientCode} · {r.serviceName}</th>
                  <td className="px-2 py-2 text-right">{m(r.authorizedMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.scheduledMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.heldReviewMinutes)}</td>
                  <td className={`px-2 py-2 text-right ${r.needsReconciliationMinutes > 0 ? "font-semibold text-amber-900" : ""}`}>{m(r.needsReconciliationMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.workedMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.confirmedMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.billableMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.needsCorrectionMinutes)}{r.needsCorrectionVisits > 0 ? ` (${r.needsCorrectionVisits})` : ""}</td>
                  <td className="px-2 py-2 text-right">{m(r.readyForReviewMinutes)}</td>
                  <td className="px-2 py-2 text-right">{m(r.humanApprovedMinutes)}</td>
                  <td className={`px-2 py-2 text-right ${r.remainingMinutes < 0 ? "font-semibold text-red-700" : ""}`}>{signed(r.remainingMinutes)}</td>
                  <td className="py-2 pl-2 text-right">{r.reservedOk && r.visitsOk !== false && r.balanceOk ? <span>Adds up</span> : <span className="font-semibold text-red-700">Off by {formatDuration(Math.abs(r.differenceMinutes))}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
