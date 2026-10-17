
import { Link, useSearchParams } from "react-router-dom";
import { formatDateOnly } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { hoursLabel } from "./aws-workspace";
import { useMissingRates } from "./missing-rates";
import { PageHeader } from "./ui/page-header";

export function RatesReviewPage() {
  const { hasPermission } = useOrganization();
  const [params] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : new Date().toISOString().slice(0, 7);
  const q = useMissingRates(`${month}-01`);
  if (!hasPermission("billing.read")) return <p className="text-sm text-og-sub">Rates and dollar values are visible to the agency Administrator only.</p>;
  const rows = q.data ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Authorizations without a rate" lead={`Add the hourly rate so ${month} dollar values include these hours.`} />
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p> : null}
      {q.data && rows.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub">Every authorization for this month has a rate.</p> : null}
      {rows.length > 0 ? (
        <>
          <p className="text-sm font-semibold text-og-ink" data-testid="missing-rate-count">{rows.length} {rows.length === 1 ? "authorization" : "authorizations"} to review</p>
          <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card">
            {rows.map((r) => (
              <li key={r.authorizationId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold text-og-ink">{r.clientName ?? r.clientCode}</span>
                  <span className="text-og-sub"> · {r.serviceName} · {hoursLabel(r.monthlyAuthorizedMinutes)}/month · {formatDateOnly(r.periodStart)}–{formatDateOnly(r.periodEnd)}{r.payer ? ` · ${r.payer}` : ""}</span>
                </span>
                <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to={`/clients/${r.clientId}`}>Open client</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
