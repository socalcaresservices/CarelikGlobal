import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { formatHours, formatVisitDate } from "@/lib/service-verification";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import { useOrganization } from "@/providers/organization-provider";

function monthBounds(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
}

const REVIEW_LABEL: Record<string, string> = {
  ready: "Billing ready",
  needs_review: "Needs review",
};

/**
 * Billing-review DATA (read-only). Billing Ready is not billed: approval and
 * submission remain explicit human steps that this screen does not perform.
 */
export function BillingReviewPage() {
  const backend = useServiceVerificationBackend();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [{ from, to }, setRange] = useState(monthBounds);
  const [signature, setSignature] = useState<{ visitId: string; url: string | null; error: string | null } | null>(null);
  const canRead = hasPermission("billing.visits.read");

  const query = useQuery({
    queryKey: ["aws-billing-review", activeOrganizationId, from, to],
    queryFn: () => backend.listBillingReview!(activeOrganizationId!, from, to),
    enabled: !!activeOrganizationId && canRead && !!backend.listBillingReview,
  });

  async function showSignature(visitId: string) {
    setSignature({ visitId, url: null, error: null });
    try {
      setSignature({ visitId, url: await backend.getSignatureDataUrl!(visitId), error: null });
    } catch (cause) {
      setSignature({ visitId, url: null, error: cause instanceof Error ? cause.message : "Could not load the signature." });
    }
  }

  if (!canRead) return <p className="text-sm text-slate-600">You do not have access to billing review.</p>;

  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-950">Billing review</h1>
        <p className="mt-1 text-sm text-slate-600">
          Billing Ready means the visit passed the automatic checks. It has not been approved, billed, or submitted.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-600">
          From
          <input type="date" value={from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <input type="date" value={to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>
      {query.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {query.isError ? <p role="alert" className="text-sm text-red-700">{(query.error as Error).message}</p> : null}
      {!query.isLoading && !query.isError && rows.length === 0 ? <p className="text-sm text-slate-500">No signed or review visits in this range.</p> : null}
      {rows.length > 0 ? (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Visit</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Service</th>
                <th className="px-3 py-2">Worked h</th>
                <th className="px-3 py-2">Billable h</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.visitId} className="border-t border-slate-100">
                  <td className="px-3 py-2">{r.visitNumber ?? "—"}{r.isCorrection ? " (corrected)" : ""}</td>
                  <td className="px-3 py-2">{formatVisitDate(`${r.serviceDate}T12:00:00Z`)}</td>
                  <td className="px-3 py-2">{r.serviceCode}</td>
                  <td className="px-3 py-2">{formatHours(r.workedMinutes ?? 0)}</td>
                  <td className="px-3 py-2">{formatHours(r.billableMinutes ?? 0)}</td>
                  <td className="px-3 py-2">{REVIEW_LABEL[r.reviewState] ?? r.reviewState}</td>
                  <td className="px-3 py-2">
                    {r.hasSignatureEvidence ? (
                      <Button type="button" variant="secondary" onClick={() => void showSignature(r.visitId)}>View signature</Button>
                    ) : (
                      r.confirmationMethod ?? "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {signature ? (
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">Client signature</p>
            <button type="button" className="text-xs text-slate-500 underline" onClick={() => setSignature(null)}>Close</button>
          </div>
          {signature.error ? <p role="alert" className="mt-2 text-sm text-red-700">{signature.error}</p> : null}
          {signature.url ? <img src={signature.url} alt="Client signature for the selected visit" className="mt-3 max-h-48 rounded border border-slate-200 bg-white" /> : null}
          {!signature.url && !signature.error ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
