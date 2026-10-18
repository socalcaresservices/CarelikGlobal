import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { useIsNarrow } from "@/lib/use-is-narrow";
import { formatDateOnly, formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { PageHeader } from "./ui/page-header";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export interface AmendmentImpact {
  impactId: string; createdAt: string; impactKind: "reserved_shift_over_cap" | "reserved_shift_outside_period" | "decrease_now_exceeds" | "increase_may_allow_more" | "visit_over_cap" | "visit_outside_period";
  clientCode: string; serviceCode: string; serviceName: string; newVersionNumber: number; newMonthlyMinutes: number;
  shiftId: string | null; shiftStartsAt: string | null; shiftEndsAt: string | null; visitId: string | null; serviceDate: string; minutes: number | null;
  bucket: string | null; stillApplicable: boolean; acknowledgedAt: string | null; acknowledgedByName: string | null; acknowledgementNote: string | null; amendedByName: string | null;
  visitBillingState: string | null; reviewOpen: boolean | null; detail: Record<string, unknown> | null;
}

const IMPACT_TEXT: Record<AmendmentImpact["impactKind"], string> = {
  reserved_shift_over_cap: "This reserved shift no longer fits the new monthly limit.",
  reserved_shift_outside_period: "This reserved shift is outside the new authorization period.",
  decrease_now_exceeds: "A signed or in-review visit now exceeds the lowered limit.",
  increase_may_allow_more: "The higher limit may allow minutes that were previously over.",
  visit_over_cap: "A confirmed visit now goes past the lowered monthly limit.",
  visit_outside_period: "A confirmed visit now falls outside the shortened authorization period.",
};

/** 0068: what authorization amendments affected. Nothing was changed, released or re-billed by the amendment; each item stays until a person acknowledges it. */
export function AuthorizationImpactsPage() {
  const narrow = useIsNarrow();
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { when, time } = useAgencyClock();
  const allowed = hasPermission("authorizations.update") || hasPermission("shifts.manage");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const q = useQuery({
    queryKey: ["authorization-impacts", activeOrganizationId, showAll],
    queryFn: async () => (await api.get<{ impacts: AmendmentImpact[] }>("/v1/authorization-impacts", { organizationId: activeOrganizationId, includeAcknowledged: showAll ? "true" : "false" })).impacts,
    enabled: !!activeOrganizationId && allowed,
  });
  async function acknowledge(i: AmendmentImpact) {
    if (busy) return;
    if (note.trim().length < 5) return setError({ id: i.impactId, text: "Note missing. Write what you did or decided." });
    setBusy(i.impactId);
    setError(null);
    try {
      await api.post(`/v1/authorization-impacts/${encodeURIComponent(i.impactId)}/acknowledge`, { organizationId: activeOrganizationId, note: note.trim() });
      setOpen(null);
      setNote("");
    } catch (cause) {
      setError({ id: i.impactId, text: message(cause, "Not saved. Try again.") });
    } finally {
      setBusy(null);
      await Promise.all(["authorization-impacts", "attention-overview"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    }
  }
  if (!allowed) return <p className="text-sm text-og-sub">You do not have access to authorization changes.</p>;
  // One card per authorization change (client, service, version, who amended and when); the affected shifts and visits are listed once under it.
  const groups: { key: string; first: AmendmentImpact; items: AmendmentImpact[] }[] = [];
  for (const i of q.data ?? []) {
    const key = [i.clientCode, i.serviceCode, i.newVersionNumber, i.amendedByName ?? "", i.createdAt.slice(0, 10)].join("|");
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(i); else groups.push({ key, first: i, items: [i] });
  }
  function itemParts(i: AmendmentImpact) {
    const open_ = open === i.impactId;
    return {
      what: IMPACT_TEXT[i.impactKind],
      when: (
        <>
          {i.shiftId && i.shiftStartsAt && i.shiftEndsAt ? <>Shift {when(i.shiftStartsAt)}–{time(i.shiftEndsAt)}</> : <>Visit on {formatDateOnly(i.serviceDate)}</>}
          {i.minutes != null ? <> · {formatDuration(i.minutes)}</> : null}
        </>
      ),
      stale: !i.stillApplicable ? "No longer applies (the shift was released or the visit changed)." : null,
      notes: (
        <>
          {i.visitId && i.visitBillingState === "approved_for_billing" ? <p className="text-amber-900" data-testid="approved-unchanged">This visit is already approved for billing. It was not changed. To review it, void the approval first.</p> : null}
          {i.visitId && i.reviewOpen ? <p className="text-amber-900" data-testid="sent-back">This visit was sent back to review (Needs Correction) and stays there until a person confirms it is still billable or corrects it.</p> : null}
          {i.visitId && i.visitBillingState && !i.reviewOpen && i.visitBillingState !== "approved_for_billing" ? <p className="text-slate-700">Current state: {i.visitBillingState.replace(/_/g, " ")}.</p> : null}
          {i.acknowledgedAt ? <p className="text-emerald-800">Acknowledged by {i.acknowledgedByName ?? "someone"}: “{i.acknowledgementNote}”</p> : null}
          {error?.id === i.impactId ? <p role="alert" className="text-red-700">{error.text}</p> : null}
        </>
      ),
      actions: !i.acknowledgedAt && !open_ ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {i.shiftId ? <Link className="inline-flex min-h-11 items-center text-sm underline md:min-h-8" to="/schedule">Open the schedule</Link> : <Link className="inline-flex min-h-11 items-center text-sm underline md:min-h-8" to={`/visits/${i.visitId}`}>Open the visit</Link>}
          <Button type="button" variant="secondary" size="sm" className="min-h-11 md:min-h-8" onClick={() => { setOpen(i.impactId); setNote(""); setError(null); }}>Acknowledge…</Button>
        </div>
      ) : null,
      form: !i.acknowledgedAt && open_ ? (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-600">What did you do or decide?
            <textarea value={note} rows={2} maxLength={1000} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" loading={busy === i.impactId} disabled={busy !== null} onClick={() => void acknowledge(i)}>Acknowledge</Button>
            <button type="button" className="min-h-11 text-sm underline" onClick={() => { setOpen(null); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : null,
    } satisfies Record<string, ReactNode>;
  }
  function itemRows(i: AmendmentImpact) {
    const p = itemParts(i);
    if (narrow) {
      return (
        <li key={i.impactId} data-testid="amendment-impact" className="rounded-lg border border-slate-200">
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center px-3 py-1 text-sm text-slate-900">{p.when}</summary>
            <div className="space-y-1 px-3 pb-3 text-sm text-slate-800">
              <p>{p.what}{p.stale ? ` ${p.stale}` : ""}</p>
              {p.notes}
              {p.actions}
              {p.form}
            </div>
          </details>
        </li>
      );
    }
    return (
      <tbody key={i.impactId} data-testid="amendment-impact" className="border-t border-slate-200 align-top">
        <tr>
          <td className="whitespace-nowrap py-1.5 pl-2 pr-3 font-medium text-slate-900">{p.when}</td>
          <td className="py-1.5 pr-3 text-slate-800">
            <p>{p.what}{p.stale ? ` ${p.stale}` : ""}</p>
            <div className="space-y-0.5 text-xs">{p.notes}</div>
          </td>
          <td className="py-1 pr-2 text-right">{p.actions}</td>
        </tr>
        {p.form ? <tr><td colSpan={3} className="pb-2 pl-2 pr-2">{p.form}</td></tr> : null}
      </tbody>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Authorization changes" lead="Shifts and visits affected by a lowered or shortened authorization, to review. The amendment changed, released and re-billed nothing." />
      <p className="text-sm text-og-sub">To add or amend an authorization, open the client and use Authorizations (Add authorization, Amend, Renew). <Link className="underline" to="/clients">Go to Clients</Link></p>
      <label className="flex min-h-6 items-center gap-2 text-sm text-og-ink [@media(pointer:coarse)]:min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show items already acknowledged</label>
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{message(q.error, "Could not load.")}</p> : null}
      {q.data && q.data.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub" role="status">Nothing to review.</p> : null}
      <ul className="space-y-3" aria-label="Authorization changes">
        {groups.map((g) => (
          <li key={g.key} data-testid="amendment-group">
            <Card className="space-y-2 p-3 text-sm">
              <div>
                <h2 className="text-base font-semibold text-slate-950">Client {g.first.clientCode} · {g.first.serviceName} · version {g.first.newVersionNumber} ({formatDuration(g.first.newMonthlyMinutes)} a month)</h2>
                <p className="text-xs text-slate-600">Amended by {g.first.amendedByName ?? "an administrator"} on {formatDateOnly(g.first.createdAt.slice(0, 10))}. {g.items.length} {g.items.length === 1 ? "item" : "items"} affected.</p>
              </div>
              {narrow ? (
                <ul className="space-y-2" aria-label={`Items affected, client ${g.first.clientCode} version ${g.first.newVersionNumber}`}>{g.items.map((i) => itemRows(i))}</ul>
              ) : (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Items affected, client {g.first.clientCode} version {g.first.newVersionNumber}</caption>
                  <thead className="text-xs text-slate-600"><tr><th scope="col" className="py-1 pl-2 pr-3 font-medium">Affected</th><th scope="col" className="py-1 pr-3 font-medium">What happened</th><th scope="col" className="py-1 pr-2 text-right font-medium">Action</th></tr></thead>
                  {g.items.map((i) => itemRows(i))}
                </table>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
