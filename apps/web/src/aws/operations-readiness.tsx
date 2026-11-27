// Operations readiness (behind the `operationsReadiness` release switch): one page for the four things an agency has to watch to keep care covered and billable:
// authorizations that are ending, documents that are expiring or waiting, shifts that nobody is covering, and caregiver compliance. It shows the SAME figures as the Dashboard, Documents,
// Schedule and Compliance pages (one server call that composes their existing functions) and links to them; it changes nothing. A part the server could not give is named, never shown as zero.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { hoursLabel } from "./aws-workspace";
import { PageHeader } from "./ui/page-header";
import { SortTh } from "./ui/sort-th";
import { useSortedRows } from "./ui/table-sort";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";

interface Expiring { clientId: string; clientCode: string; serviceName: string; endsOn: string; daysLeft: number; availableMinutes: number | string }
interface Upcoming { shiftId: string; startsAt: string; endsAt: string; reason: "open" | "called_out" | "compliance_hold" | "documents_not_current"; clientCode: string | null; clientName?: string | null; serviceName: string | null }
interface Readiness {
  asOf: string;
  overview: { urgentWindowHours: number; upcoming: { count: number; shifts: Upcoming[] } | null; pickups?: { count: number } | null; reconciliation?: { count: number } | null;
    documents: { overdue?: number; dueSoon?: number; awaitingReview?: number; reviewOverdue?: number; rejected?: number; caregiversOnHold?: number; caregiversWithPendingRequirements?: number } | null } | null;
  expiring: Expiring[] | null;
  compliance: { enforcementActive: boolean; readyOrActive: number; wouldBeHeld: number; pastDeadline: number; hireDateMissing: number; strictDocumentProblem: number; openHolds: number } | null;
  unavailable: string[];
}
const REASON: Record<Upcoming["reason"], string> = { open: "No caregiver assigned", called_out: "Caregiver called out", compliance_hold: "Caregiver on compliance hold", documents_not_current: "Caregiver documents not current" };
export const READINESS_REFRESH_MS = 60_000;

export function OperationsReadinessPage() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["operations-readiness", activeOrganizationId], enabled: !!activeOrganizationId, retry: false, refetchInterval: READINESS_REFRESH_MS,
    queryFn: async () => (await api.get<{ readiness: Readiness }>("/v1/operations-readiness", { organizationId: activeOrganizationId })).readiness,
  });
  const exp = useSortedRows(q.data?.expiring ?? [], {
    client: { get: (r) => r.clientCode }, service: { get: (r) => r.serviceName }, ends: { get: (r) => r.endsOn, kind: "date" }, days: { get: (r) => r.daysLeft, kind: "number" }, hours: { get: (r) => Number(r.availableMinutes), kind: "number" },
  });
  const shifts = useSortedRows(q.data?.overview?.upcoming?.shifts ?? [], {
    when: { get: (r) => r.startsAt, kind: "date" }, client: { get: (r) => r.clientName ?? r.clientCode }, service: { get: (r) => r.serviceName }, why: { get: (r) => REASON[r.reason] },
  });
  if (q.isError && (q.error as { code?: string } | null)?.code === "not_available") return <div className="space-y-2"><PageHeader title="Operations readiness" /><p className="text-sm text-og-sub" data-testid="ops-unavailable">Operations readiness is not available in this environment yet.</p></div>;
  const d = q.data;
  const missing = (name: string) => d?.unavailable.includes(name);
  return (
    <div className="space-y-3">
      <PageHeader title="Operations readiness" lead="What needs attention to keep care covered and billable: ending authorizations, expiring documents, uncovered shifts and caregiver compliance. The numbers are the same ones the other pages show." />
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">Operations readiness could not be loaded. It is not shown as zero. <button type="button" className="font-semibold underline" onClick={() => void q.refetch()}>Retry</button></p> : null}
      {d ? <p className="text-xs text-og-sub" data-testid="ops-asof">As of {formatNumericDate(d.asOf)} {formatClockTime(d.asOf)}</p> : null}

      {d ? <section aria-label="Authorizations ending" className="space-y-1 rounded-og border border-og-line bg-og-card p-3">
        <h2 className="font-semibold">Authorizations ending (next 30 days)</h2>
        {missing("expiring") ? <p role="alert" className="text-sm text-amber-900" data-testid="ops-missing-expiring">Not available to your role. It is not shown as none.</p>
          : d.expiring && d.expiring.length === 0 ? <p className="text-sm text-og-sub">No authorization with available hours ends in the next 30 days.</p>
          : <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Authorizations ending">
              <thead><tr className="text-xs uppercase tracking-wide text-og-sub">
                <SortTh sort={exp.sort} column="client" className="py-1 pr-3">Client</SortTh><SortTh sort={exp.sort} column="service" className="py-1 pr-3">Service</SortTh>
                <SortTh sort={exp.sort} column="ends" kind="date" className="py-1 pr-3">Ends</SortTh><SortTh sort={exp.sort} column="days" kind="number" className="py-1 pr-3">Days left</SortTh><SortTh sort={exp.sort} column="hours" kind="number" className="py-1">Hours available</SortTh>
              </tr></thead>
              <tbody>{exp.rows.map((r, i) => (
                <tr key={`${r.clientId}-${r.serviceName}-${i}`} className="border-t border-og-line">
                  <td className="py-1 pr-3"><Link className="underline" to={`/service-verification/reports?${new URLSearchParams({ view: "reconciliation", client: r.clientId, month: r.endsOn.slice(0, 7) })}`}>{r.clientCode}</Link></td>
                  <td className="py-1 pr-3">{r.serviceName}</td><td className="py-1 pr-3">{formatNumericDate(r.endsOn)}</td>
                  <td className={`py-1 pr-3 ${r.daysLeft <= 7 ? "font-semibold text-red-700" : ""}`}>{r.daysLeft}</td><td className="py-1">{hoursLabel(Number(r.availableMinutes))}</td>
                </tr>))}</tbody>
            </table></div>}
      </section> : null}

      {d ? <section aria-label="Documents" className="space-y-1 rounded-og border border-og-line bg-og-card p-3">
        <h2 className="font-semibold">Documents</h2>
        {missing("overview") || !d.overview?.documents ? <p role="alert" className="text-sm text-amber-900" data-testid="ops-missing-documents">Not available to your role. It is not shown as none.</p> : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {([["Overdue", d.overview.documents.overdue], ["Due soon", d.overview.documents.dueSoon], ["Waiting for review", d.overview.documents.awaitingReview], ["Review overdue", d.overview.documents.reviewOverdue], ["Rejected", d.overview.documents.rejected]] as const).map(([label, n]) => (
              <div key={label}><dt className="text-xs text-og-sub">{label}</dt><dd className={`font-og-mono tabular-nums ${(n ?? 0) > 0 && label !== "Waiting for review" ? "font-semibold text-amber-900" : ""}`}>{n ?? 0}</dd></div>
            ))}
          </dl>)}
        <Link className="inline-flex min-h-[44px] items-center text-sm font-semibold underline md:min-h-[28px]" to="/documents">Open Documents</Link>
      </section> : null}

      {d ? <section aria-label="Open shifts" className="space-y-1 rounded-og border border-og-line bg-og-card p-3">
        <h2 className="font-semibold">Open shifts (next {d.overview?.urgentWindowHours ?? 48} hours)</h2>
        {missing("overview") || !d.overview?.upcoming ? <p role="alert" className="text-sm text-amber-900" data-testid="ops-missing-shifts">Not available to your role. It is not shown as none.</p>
          : d.overview.upcoming.count === 0 ? <p className="text-sm text-og-sub">Every shift in this window has a caregiver who may work it.</p>
          : <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Open shifts">
              <thead><tr className="text-xs uppercase tracking-wide text-og-sub">
                <SortTh sort={shifts.sort} column="when" kind="date" className="py-1 pr-3">When</SortTh><SortTh sort={shifts.sort} column="client" className="py-1 pr-3">Client</SortTh>
                <SortTh sort={shifts.sort} column="service" className="py-1 pr-3">Service</SortTh><SortTh sort={shifts.sort} column="why" className="py-1">Why</SortTh>
              </tr></thead>
              <tbody>{shifts.rows.map((r) => (
                <tr key={r.shiftId} className="border-t border-og-line"><td className="py-1 pr-3 whitespace-nowrap">{formatNumericDate(r.startsAt)} {formatClockTime(r.startsAt)}</td>
                  <td className="py-1 pr-3"><Link className="underline" to={`/schedule?shift=${r.shiftId}`}>{r.clientName ?? r.clientCode ?? "Client"}</Link></td><td className="py-1 pr-3">{r.serviceName ?? "Service"}</td><td className="py-1">{REASON[r.reason]}</td></tr>))}</tbody>
            </table></div>}
        <p className="text-sm text-og-sub">{d.overview?.pickups ? `${d.overview.pickups.count} caregiver request${d.overview.pickups.count === 1 ? "" : "s"} for open shifts waiting for the office. ` : ""}<Link className="font-semibold underline" to="/schedule?coverage=1">Open Schedule (shifts needing cover)</Link></p>
      </section> : null}

      {d ? <section aria-label="Compliance alerts" className="space-y-1 rounded-og border border-og-line bg-og-card p-3">
        <h2 className="font-semibold">Compliance alerts</h2>
        {missing("compliance") || !d.compliance ? <p role="alert" className="text-sm text-amber-900" data-testid="ops-missing-compliance">Not available to your role. It is not shown as none.</p> : (
          <>
            <p className="text-sm text-og-sub">{d.compliance.enforcementActive ? "Compliance rules are being enforced." : "Compliance rules are report-only: nobody is blocked yet."}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              {([["Caregivers on hold", d.compliance.openHolds], ["Would be held if enforced", d.compliance.wouldBeHeld], ["Past a deadline", d.compliance.pastDeadline], ["Hire date missing", d.compliance.hireDateMissing], ["Document problems", d.compliance.strictDocumentProblem]] as const).map(([label, n]) => (
                <div key={label}><dt className="text-xs text-og-sub">{label}</dt><dd className={`font-og-mono tabular-nums ${n > 0 ? "font-semibold text-amber-900" : ""}`}>{n}</dd></div>
              ))}
            </dl>
          </>)}
        <Link className="inline-flex min-h-[44px] items-center text-sm font-semibold underline md:min-h-[28px]" to="/compliance">Open compliance holds</Link>
      </section> : null}
    </div>
  );
}
