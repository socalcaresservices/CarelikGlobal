import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { buildXlsx, XLSX_CONTENT_TYPE } from "@carelik/shared";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { Dialog, ProfileBlock, ProfileRow, StatusChip, rowButton } from "../profile-ui";
import type { ReadinessItem, ReadinessOverride } from "./readiness-data";
import { REFRESH, useReadinessOverrides, EXPORT_HEAD, overrideExportRows } from "./readiness-overrides-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/**
 * Admin overrides of caregiver-readiness blocks (0123, behind the readinessOverrides release switch). An administrator (caregivers.compliance.manage) lifts ONE block for ONE caregiver and ONE exact
 * issue (a CPR or TB document that is missing, waiting for review, rejected or expired), with a reason. The document keeps its status; the override is only shown beside it. The server decides.
 */
function useRefresh() {
  const qc = useQueryClient();
  return async () => { for (const k of REFRESH) await qc.invalidateQueries({ queryKey: [k] }); };
}

const REQUIREMENT = { cpr: "CPR", tb: "TB" } as const;

/** Approve: names the specific block, requires a reason, and says plainly what it does and does not do. */
export function ApproveOverrideDialog({ caregiverRecordId, item, onClose }: { caregiverRecordId: string; item: ReadinessItem; onClose: () => void }) {
  const api = useAwsApi();
  const refresh = useRefresh();
  const { activeOrganizationId } = useOrganization();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const req = item.requirement === "tb" ? "tb" : "cpr";
  const when = item.extra.validUntil ? formatDateOnly(item.extra.validUntil) : null;
  async function submit() {
    if (reason.trim().length < 5) return setState({ busy: false, error: "Write the reason for this override (at least 5 characters)." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/readiness-override`, { organizationId: activeOrganizationId, requirement: req, issueKey: item.extra.issueKey, reason: reason.trim() }, { idempotencyKey: key.current });
      await refresh();
      onClose();
    } catch (cause) { setState({ busy: false, error: message(cause, "The override was not saved.") }); }
  }
  return (
    <Dialog title="Approve override" onClose={onClose} testId="override-approve-dialog">
      <p className="text-sm text-slate-900" data-testid="override-block">
        <strong>{REQUIREMENT[req]}</strong> · {item.extra.issueLabel ?? "Document issue"}{item.extra.issueStatus === "expired" && when ? ` · expired ${when}` : when ? ` · ${when}` : ""}
      </p>
      <p className="text-sm text-slate-700">This lets the caregiver be scheduled while this one issue stays open. The document stays {(item.extra.issueLabel ?? "as it is").toLowerCase().replace(" doc", "")} and is <strong>not</strong> marked current or verified. It covers only this document and expiry: a different document, or a later expiry, needs a new decision. Overlapping shifts, hour limits and client authorization still apply.</p>
      <label className="block text-sm font-medium text-slate-900">Reason (required)
        <textarea value={reason} maxLength={500} rows={3} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm" />
      </label>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={rowButton} onClick={onClose}>Cancel</button>
        <Button type="button" disabled={state.busy} onClick={() => void submit()}>{state.busy ? "Saving…" : "Approve override"}</Button>
      </div>
    </Dialog>
  );
}

function RevokeOverrideDialog({ override, requirement, onClose }: { override: ReadinessOverride; requirement: string; onClose: () => void }) {
  const api = useAwsApi();
  const refresh = useRefresh();
  const { activeOrganizationId } = useOrganization();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (reason.trim().length < 5) return setState({ busy: false, error: "Write the reason for revoking this override (at least 5 characters)." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/readiness-overrides/${encodeURIComponent(override.id)}/revoke`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: key.current });
      await refresh();
      onClose();
    } catch (cause) { setState({ busy: false, error: message(cause, "The override was not revoked.") }); }
  }
  return (
    <Dialog title="Revoke override" onClose={onClose} testId="override-revoke-dialog">
      <p className="text-sm text-slate-900"><strong>{requirement === "tb" ? "TB" : "CPR"}</strong> · approved {formatDateTime(override.approvedAt)}{override.approvedByName ? ` by ${override.approvedByName}` : ""}</p>
      <p className="text-sm text-slate-700">Revoking puts the block back in force if the document issue is still open. The approval stays in the history.</p>
      <label className="block text-sm font-medium text-slate-900">Reason (required)
        <textarea value={reason} maxLength={500} rows={3} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm" />
      </label>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={rowButton} onClick={onClose}>Cancel</button>
        <Button type="button" disabled={state.busy} onClick={() => void submit()}>{state.busy ? "Saving…" : "Revoke override"}</Button>
      </div>
    </Dialog>
  );
}

/** Details of the override in force: expiration date, approving admin, approval time, reason, and Revoke (administrators). Earlier approvals and revocations are kept below. */
export function OverrideDetails({ caregiverRecordId, item, canRevoke }: { caregiverRecordId: string; item: ReadinessItem; canRevoke: boolean }) {
  const o = item.extra.override && typeof item.extra.override === "object" ? item.extra.override : null;
  const history = useReadinessOverrides(caregiverRecordId, canRevoke);
  const [revoking, setRevoking] = useState(false);
  if (!o) return null;
  const earlier = history.rows.filter((r) => r.requirement === item.requirement && r.id !== o.id);
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="override-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-medium text-slate-700">Document</dt><dd>{item.extra.issueLabel ?? "Document issue"}</dd>
        <dt className="font-medium text-slate-700">Expiration date</dt><dd data-testid="override-expiry">{o.validUntil ? formatDateOnly(o.validUntil) : "No document on file"}</dd>
        <dt className="font-medium text-slate-700">Approved by</dt><dd>{o.approvedByName ?? "An administrator"}</dd>
        <dt className="font-medium text-slate-700">Approved</dt><dd>{formatDateTime(o.approvedAt)}</dd>
        <dt className="font-medium text-slate-700">Reason</dt><dd className="break-words">{o.reason}</dd>
      </dl>
      <p className="mt-2 text-xs text-slate-600">The document is still {(item.extra.issueLabel ?? "").toLowerCase().replace(" doc", "") || "not current"}; this approval does not make it current or verified. It ends when the document is fixed, or an administrator revokes it.</p>
      {canRevoke ? <div className="mt-2"><button type="button" className={rowButton} onClick={() => setRevoking(true)}>Revoke</button></div> : null}
      {earlier.length > 0 ? (
        <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-slate-700">History ({earlier.length})</summary>
          <ul className="mt-1 space-y-1 text-xs text-slate-700">
            {earlier.map((r) => <li key={r.id}>Approved {formatDateTime(r.approvedAt)}{r.approvedByName ? ` by ${r.approvedByName}` : ""}: {r.reason}{r.revokedAt ? ` Revoked ${formatDateTime(r.revokedAt)}${r.revokedByName ? ` by ${r.revokedByName}` : ""}: ${r.revokeReason ?? ""}` : ""}</li>)}
          </ul></details>
      ) : null}
      {revoking ? <RevokeOverrideDialog override={o} requirement={item.requirement} onClose={() => setRevoking(false)} /> : null}
    </div>
  );
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Compliance report: every admin-approved exception, whether the issue still applies, who approved it and why. Active first, then the history. */
export function ReadinessOverridesReport() {
  const { hasPermission } = useOrganization();
  const q = useReadinessOverrides(null, hasPermission("readiness.read") || hasPermission("caregivers.compliance.manage"));
  if (!q.available) return null;
  return (
    <section aria-label="Admin-approved exceptions" data-testid="overrides-report" className="space-y-1">
      <h2 className="text-base font-semibold text-slate-950">Admin-approved exceptions</h2>
      <p className="text-xs text-slate-600">A document issue an administrator allowed work to continue through. The document is not fixed until it is verified again.</p>
      {q.rows.length > 0 ? (
        <div className="flex flex-wrap gap-2 print:hidden" data-testid="overrides-export">
          <button type="button" className={rowButton} onClick={() => {
            const csv = [EXPORT_HEAD, ...overrideExportRows(q.rows)].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
            download(`admin-approved-exceptions-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([csv], { type: "text/csv;charset=utf-8" }));
          }}>Export CSV</button>
          <button type="button" className={rowButton} onClick={() => download(`admin-approved-exceptions-${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([buildXlsx([{ name: "Admin-approved exceptions", rows: [EXPORT_HEAD, ...overrideExportRows(q.rows)] }]) as BlobPart], { type: XLSX_CONTENT_TYPE }))}>Export Excel</button>
          <button type="button" className={rowButton} onClick={() => window.print()}>Print or save as PDF</button>
        </div>
      ) : null}
      {q.rows.length === 0 ? <p className="text-sm text-slate-700">None.</p> : (
        <ProfileBlock label="Admin-approved exceptions list">
          {q.rows.map((r) => (
            <ProfileRow key={r.id} testId={`override-${r.id}`} label={`${r.caregiverName} · ${REQUIREMENT[r.requirement]}`}
              status={r.active ? <StatusChip tone="override">Admin Approved</StatusChip> : <StatusChip tone="neutral">Revoked</StatusChip>}
              value={<>
                <span className="font-medium">{r.issueLabel}</span>{r.validUntil ? <span className="text-slate-700"> · {formatDateOnly(r.validUntil)}</span> : null}
                {r.active && !r.stillApplies ? <span className="ml-1 text-xs text-slate-600">(issue fixed or changed)</span> : null}
                <span className="block text-xs text-slate-600">{r.approvedByName ? `${r.approvedByName}, ` : ""}{formatDateTime(r.approvedAt)}: {r.reason}</span>
                {r.revokedAt ? <span className="block text-xs text-slate-600">Revoked {formatDateTime(r.revokedAt)}{r.revokedByName ? ` by ${r.revokedByName}` : ""}: {r.revokeReason}</span> : null}
              </>} />
          ))}
        </ProfileBlock>
      )}
    </section>
  );
}
