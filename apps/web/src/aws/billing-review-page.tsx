import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { formatHours, formatVisitDate } from "@/lib/service-verification";
import { newIdempotencyKey, type BillingApprovalRow, type BillingReviewRow } from "@/lib/sv-backend";
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

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** One open form at a time. The idempotency key is fixed when the form opens, so a retry cannot approve twice. */
type Pending =
  | { kind: "approve"; row: BillingReviewRow; minutes: string; notes: string; key: string; busy: boolean; error: string | null }
  | { kind: "void"; approval: BillingApprovalRow; reason: string; key: string; busy: boolean; error: string | null };

/**
 * Billing review and human billing approval. Billing Ready means the automatic
 * checks passed; a person with billing.approve then approves the billable
 * minutes. Approval is not payer submission. Dollar amounts appear only for
 * holders of billing.read (owner); the server returns null to everyone else.
 */
export function BillingReviewPage() {
  const backend = useServiceVerificationBackend();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [{ from, to }, setRange] = useState(monthBounds);
  const [signature, setSignature] = useState<{ visitId: string; url: string | null; error: string | null } | null>(null);
  const canRead = hasPermission("billing.visits.read");
  const canApprove = hasPermission("billing.approve") && !!backend.approveVisitForBilling;
  const canSeeMoney = hasPermission("billing.read");
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["aws-billing-review", activeOrganizationId, from, to],
    queryFn: () => backend.listBillingReview!(activeOrganizationId!, from, to),
    enabled: !!activeOrganizationId && canRead && !!backend.listBillingReview,
  });
  const approvalsQuery = useQuery({
    queryKey: ["aws-billing-approvals", activeOrganizationId, from, to],
    queryFn: () => backend.listBillingApprovals!(activeOrganizationId!, from, to),
    enabled: !!activeOrganizationId && canRead && !!backend.listBillingApprovals,
  });
  const activeApproval = new Map<string, BillingApprovalRow>();
  for (const a of approvalsQuery.data ?? []) if (!a.voidedAt) activeApproval.set(a.visitId, a);

  async function submitPending() {
    if (!pending || pending.busy) return;
    if (pending.kind === "approve") {
      const minutes = Number(pending.minutes);
      const max = pending.row.billableMinutes ?? 0;
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > max) {
        setPending({ ...pending, error: `Enter whole minutes from 0 to ${max}.` });
        return;
      }
      setPending({ ...pending, busy: true, error: null });
      try {
        await backend.approveVisitForBilling!({ visitId: pending.row.visitId, approvedMinutes: minutes, notes: pending.notes.trim() || null, idempotencyKey: pending.key });
        setNotice(`Visit ${pending.row.visitNumber ?? ""} approved for billing (${formatHours(minutes)} h). It has not been submitted.`);
        setPending(null);
      } catch (cause) {
        setPending({ ...pending, busy: false, error: cause instanceof Error ? cause.message : "Approval failed. Nothing was approved; try again." });
        return;
      }
    } else {
      if (!pending.reason.trim()) {
        setPending({ ...pending, error: "A reason is required." });
        return;
      }
      setPending({ ...pending, busy: true, error: null });
      try {
        await backend.voidBillingApproval!({ billingApprovalId: pending.approval.billingApprovalId, reason: pending.reason.trim(), idempotencyKey: pending.key });
        setNotice(`Approval for visit ${pending.approval.visitNumber ?? ""} voided. The visit is Billing ready again.`);
        setPending(null);
      } catch (cause) {
        setPending({ ...pending, busy: false, error: cause instanceof Error ? cause.message : "Void failed. The approval still stands; try again." });
        return;
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["aws-billing-approvals"] });
    await queryClient.invalidateQueries({ queryKey: ["aws-billing-review"] });
  }

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
          Billing ready means the visit passed the automatic checks. Approving it is a separate human step, and
          approval is not submission: nothing is sent to a payer from this screen.
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
      {approvalsQuery.isError ? <p role="alert" className="text-sm text-red-700">Approvals could not be loaded: {(approvalsQuery.error as Error).message}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      {!query.isLoading && !query.isError && rows.length === 0 ? <p className="text-sm text-slate-500">No signed or review visits in this range.</p> : null}
      {rows.length > 0 ? (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2">Visit</th>
                <th scope="col" className="px-3 py-2">Date</th>
                <th scope="col" className="px-3 py-2">Service</th>
                <th scope="col" className="px-3 py-2">Worked h</th>
                <th scope="col" className="px-3 py-2">Billable h</th>
                <th scope="col" className="px-3 py-2">State</th>
                <th scope="col" className="px-3 py-2">Evidence</th>
                <th scope="col" className="px-3 py-2">Approval</th>
                {canSeeMoney ? <th scope="col" className="px-3 py-2">Amount</th> : null}
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
                  <td className="px-3 py-2">
                    {(() => {
                      const a = activeApproval.get(r.visitId);
                      if (a) {
                        return (
                          <div className="space-y-1">
                            <p className="font-medium text-emerald-800">Approved {formatHours(a.approvedMinutes)} h</p>
                            <p className="text-xs text-slate-500">by {a.approvedByName} · not submitted</p>
                            {canApprove ? (
                              <button type="button" className="text-xs text-slate-600 underline" onClick={() => { setNotice(null); setPending({ kind: "void", approval: a, reason: "", key: newIdempotencyKey(), busy: false, error: null }); }}>
                                Void approval
                              </button>
                            ) : null}
                          </div>
                        );
                      }
                      if (r.reviewState !== "ready") return <span className="text-slate-500">Review first</span>;
                      if (!canApprove) return <span className="text-slate-500">Not approved</span>;
                      return (
                        <Button type="button" onClick={() => { setNotice(null); setPending({ kind: "approve", row: r, minutes: String(r.billableMinutes ?? 0), notes: "", key: newIdempotencyKey(), busy: false, error: null }); }}>
                          Approve
                        </Button>
                      );
                    })()}
                  </td>
                  {canSeeMoney ? (
                    <td className="px-3 py-2">
                      {(() => {
                        const a = activeApproval.get(r.visitId);
                        if (!a) return "—";
                        return a.amountCents === null ? <span className="text-slate-500">Rate not set</span> : money(a.amountCents);
                      })()}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {pending ? (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); void submitPending(); }} className="space-y-3">
            {pending.kind === "approve" ? (
              <>
                <p className="text-sm font-medium text-slate-900">Approve visit {pending.row.visitNumber ?? ""} for billing</p>
                <p className="text-xs text-slate-600">
                  Billable: {pending.row.billableMinutes ?? 0} min ({formatHours(pending.row.billableMinutes ?? 0)} h). You can approve less, never more.
                  Approval records your name and the time. It does not submit anything to a payer.
                </p>
                <label className="block text-xs font-medium text-slate-600">
                  Approved minutes
                  <input inputMode="numeric" value={pending.minutes} onChange={(e) => setPending({ ...pending, minutes: e.target.value, error: null })} className="mt-1 block w-32 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Note (optional)
                  <input value={pending.notes} maxLength={1000} onChange={(e) => setPending({ ...pending, notes: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-900">Void the billing approval for visit {pending.approval.visitNumber ?? ""}</p>
                <p className="text-xs text-slate-600">The approval stays in the record as voided, with your reason. The visit returns to Billing ready.</p>
                <label className="block text-xs font-medium text-slate-600">
                  Reason (required)
                  <input value={pending.reason} maxLength={1000} onChange={(e) => setPending({ ...pending, reason: e.target.value, error: null })} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              </>
            )}
            {pending.error ? <p role="alert" className="text-sm text-red-700">{pending.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending.busy}>
                {pending.busy ? "Saving…" : pending.kind === "approve" ? "Approve for billing" : "Void approval"}
              </Button>
              <Button type="button" variant="secondary" disabled={pending.busy} onClick={() => setPending(null)}>Cancel</Button>
            </div>
          </form>
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
