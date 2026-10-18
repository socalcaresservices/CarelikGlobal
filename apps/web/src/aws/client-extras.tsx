// The client page, completed (Board 2): alerts with history, three primary actions, caregivers and the next three visits, readiness and service holds, documents,
// the audit timeline and a duplicate-name warning. Authorization stays first on the page. Every rule is enforced again by the server.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { issueDestination, type IssueList } from "./action-issues";
import { agencyDateOffset, useAgencyClock } from "./agency-clock";
import { useAssignments } from "./assignments-data";
import { STAGE_LABEL, useClientReadiness, type DuplicateMatch, type ReadinessService } from "./client-data";
import { useAwsApi } from "./aws-workspace";
import { prepareDocumentFile } from "./document-file";
import { uploadFailureMessage } from "./document-status";
import { SummarySection } from "./ui/summary-section";
import type { Shift } from "./schedule-page";
import { TONE } from "./attention";
import { StatusChip } from "./ui/status-chip";

const msg = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const field = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const linkCls = "inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[32px]";

// ---------------------------------------------------------------- duplicate names (13)
/** Says who already looks like this person. A same-name match needs the person to confirm it is someone else before saving. */
export function DuplicateWarning({ matches, confirmed, onConfirm }: { matches: DuplicateMatch[] | undefined; confirmed: boolean; onConfirm: (v: boolean) => void }) {
  if (!matches || matches.length === 0) return null;
  const same = matches.some((m) => m.match === "same_name");
  return (
    <div role="status" data-testid="duplicate-warning" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2">
      <p className="font-semibold">{same ? "A client with this name already exists." : "A client with a similar name already exists."}</p>
      <ul className="mt-1 list-disc pl-5">{matches.map((m) => <li key={m.clientId}><Link className="underline" to={`/clients/${m.clientId}`}>{m.firstName} {m.lastName}</Link> ({m.clientCode}, {m.status})</li>)}</ul>
      {same ? (
        <label className="mt-2 flex min-h-[44px] items-center gap-2 font-medium">
          <input type="checkbox" className="h-5 w-5" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
          This is a different person
        </label>
      ) : <p className="mt-1">Check the list before you save.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- readiness, holds (15, 16)
const SERVICE_STATE: Record<ReadinessService["state"], string> = { ready: "Ready", needs_documents: "Documents needed", held: "On hold", authorization_expired: "Authorization ended" };

function useRefreshReadiness(clientId: string) {
  const queryClient = useQueryClient();
  return async () => { for (const k of [["client-readiness", clientId], ["client-documents", clientId], ["client-audit", clientId], ["client-issues", clientId], ["action-issues"]]) await queryClient.invalidateQueries({ queryKey: k }); };
}

export function ReadinessCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const refresh = useRefreshReadiness(clientId);
  const canManage = hasPermission("clients.manage");
  const q = useClientReadiness(clientId);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const [note, setNote] = useState("");
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
  const [releaseNote, setReleaseNote] = useState("");
  const key = useRef(newIdempotencyKey());
  const r = q.data;
  if (q.isError) return <Card className="p-4"><p role="alert" className="text-sm text-red-700">Readiness could not be loaded, so it is not shown as ready. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></p></Card>;
  if (!r) return null;
  async function act(path: string, body: Record<string, unknown>, done: string) {
    if (state.busy) return;
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(path, { organizationId: activeOrganizationId, ...body }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setNote(""); setHoldFor(null); setHoldReason(""); setReleaseFor(null); setReleaseNote("");
      await refresh();
      setState({ busy: false, error: null, done });
    } catch (cause) {
      setState({ busy: false, error: msg(cause, "Not saved. Nothing changed; try again."), done: null });
    }
  }
  const preparing = r.stage === "draft" || r.stage === "pending";
  const notReady = r.services.filter((x) => x.state !== "ready").length;
  return (
    <SummarySection title="Readiness" testId="readiness-card" defaultOpen={!r.canSchedule || notReady > 0}
      status={<span data-testid="client-stage" className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">{STAGE_LABEL[r.stage]}</span>}
      summary={!r.canSchedule ? `Cannot be scheduled${preparing ? " until it is activated" : ""}.` : notReady > 0 ? `${notReady} service${notReady === 1 ? "" : "s"} to fix` : "Ready for scheduling"}>
      {r.stageNote ? <p className="mt-1 text-sm text-slate-700">{r.stageNote}</p> : null}
      {r.services.length === 0 ? <p className="mt-2 text-sm text-slate-600">No service has an authorization yet. Add one under Authorizations.</p> : (
        <ul className="mt-2 space-y-2">
          {r.services.map((s) => (
            <li key={s.serviceId} className="rounded-lg border border-slate-200 p-3" data-testid="readiness-service">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{s.serviceName}</p>
                <StatusChip tone={s.state === "ready" ? "neutral" : "amber"}>{SERVICE_STATE[s.state]}</StatusChip>
              </div>
              {s.authorization.state !== "valid" ? <p className="text-xs text-amber-900">Authorization {s.authorization.state === "expired" ? "ended" : "starts"} {formatNumericDate(s.authorization.state === "expired" ? s.authorization.periodEnd : s.authorization.periodStart)}.{s.authorization.state === "expired" ? " New scheduling is refused. Renew it under Authorizations; nothing already scheduled is deleted." : ""}</p> : null}
              {s.requirements.length > 0 ? <ul className="mt-1 text-xs text-slate-700">{s.requirements.map((x) => <li key={x.documentTypeId}>{x.state === "approved" ? "✓" : "○"} {x.name}: {x.state.replace(/_/g, " ")}</li>)}</ul> : null}
              {s.hold ? (
                <div className="mt-1 text-sm text-amber-900" data-testid="service-hold">
                  <p>On hold since {formatNumericDate(s.hold.openedAt)}{s.hold.openedByName ? ` by ${s.hold.openedByName}` : ""}: {s.hold.reason}</p>
                  {canManage && releaseFor !== s.hold.holdId ? <button type="button" className={linkCls} onClick={() => setReleaseFor(s.hold!.holdId)}>Release the hold…</button> : null}
                  {canManage && releaseFor === s.hold.holdId ? (
                    <div className="mt-1 space-y-1">
                      <label className="block text-sm font-medium text-slate-700">What did you check? (kept on record)<input value={releaseNote} maxLength={500} onChange={(e) => setReleaseNote(e.target.value)} className={field} /></label>
                      <Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={() => releaseNote.trim().length < 10 ? setState({ busy: false, error: "Write what was checked (at least 10 characters).", done: null }) : void act(`/v1/client-service-holds/${encodeURIComponent(s.hold!.holdId)}/release`, { note: releaseNote.trim() }, "The hold was released.")}>Release</Button>
                    </div>
                  ) : null}
                </div>
              ) : canManage && r.status === "active" ? (
                holdFor === s.serviceId ? (
                  <div className="mt-1 space-y-1">
                    <label className="block text-sm font-medium text-slate-700">Why is this service on hold?<input value={holdReason} maxLength={500} onChange={(e) => setHoldReason(e.target.value)} className={field} /></label>
                    <Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={() => holdReason.trim().length < 10 ? setState({ busy: false, error: "Write the reason (at least 10 characters).", done: null }) : void act(`/v1/clients/${encodeURIComponent(clientId)}/service-holds`, { serviceId: s.serviceId, reason: holdReason.trim() }, "The service is on hold. New scheduling for it is refused; other services are not affected.")}>Place on hold</Button>
                  </div>
                ) : <button type="button" className={linkCls} onClick={() => setHoldFor(s.serviceId)}>Place this service on hold…</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage && r.status === "active" ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {preparing ? <>
            {r.stage === "draft" ? <Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={() => void act(`/v1/clients/${encodeURIComponent(clientId)}/stage`, { stage: "pending", note: note.trim() || null }, "Saved as Pending.")}>Mark as Pending</Button> : null}
            <Button type="button" className="min-h-11" disabled={state.busy} onClick={() => void act(`/v1/clients/${encodeURIComponent(clientId)}/stage`, { stage: "active" }, "The client is active and can be scheduled.")}>Activate</Button>
          </> : <Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={() => void act(`/v1/clients/${encodeURIComponent(clientId)}/stage`, { stage: "draft", note: note.trim() || null }, "Saved as a draft. It cannot be scheduled until you activate it.")}>Move to Draft…</Button>}
          <label className="min-w-[200px] flex-1 text-xs font-medium text-slate-600">Note (optional)<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={field} /></label>
        </div>
      ) : null}
      {preparing ? <p className="mt-1 text-xs text-slate-600">Activation needs every required document approved and no service on hold.</p> : null}
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">{state.done}</p> : null}
    </SummarySection>
  );
}

// ---------------------------------------------------------------- documents (14)
interface ClientDoc {
  documentTypeId: string; name: string; category: string; requiresExpiry: boolean; state: "missing" | "pending_review" | "approved" | "expired" | "rejected";
  requiredFor: Array<{ serviceId: string; serviceName: string }>; documentId: string | null; latestVersionId: string | null; versionNumber: number | null; uploadedAt: string | null;
  uploadedByName: string | null; issuedOn: string | null; expiresOn: string | null; reviewedByName: string | null; reviewedAt: string | null; rejectionReason: string | null; versionCount: number | null;
}
const DOC_STATE: Record<ClientDoc["state"], string> = { missing: "Missing", pending_review: "Pending review", approved: "Approved", expired: "Expired", rejected: "Rejected" };
const CATEGORY: Record<string, string> = { consent: "Consent", authorization: "Authorization", assessment: "Assessment", insurance: "Insurance", identity: "Identity", other: "Other" };

function DocRow({ d, clientId, canManage }: { d: ClientDoc; clientId: string; canManage: boolean }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const refresh = useRefreshReadiness(clientId);
  const [mode, setMode] = useState<"upload" | "review" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [issued, setIssued] = useState("");
  const [expires, setExpires] = useState("");
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<"verified" | "rejected" | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function upload() {
    if (!file) return setState({ busy: false, error: "Choose a photo or PDF of the document." });
    if (d.requiresExpiry && !expires) return setState({ busy: false, error: "Enter the expiry date shown on the document." });
    if (issued && expires && expires <= issued) return setState({ busy: false, error: "The expiry date must be after the issue date." });
    setState({ busy: true, error: null });
    try {
      const prepared = await prepareDocumentFile(file);
      await api.post(`/v1/clients/${encodeURIComponent(clientId)}/documents/${encodeURIComponent(d.documentTypeId)}/versions`,
        { organizationId: activeOrganizationId, contentType: prepared.contentType, fileBase64: prepared.base64, issuedOn: issued || null, expiresOn: expires || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setMode(null); setFile(null);
      await refresh();
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: uploadFailureMessage(cause) });
    }
  }
  async function decide() {
    const decision = choice;
    if (!decision) return setState({ busy: false, error: "No decision chosen. Choose Approve or Reject." });
    if (decision === "rejected" && !reason.trim()) return setState({ busy: false, error: "Write why it is rejected." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/client-document-versions/${encodeURIComponent(d.latestVersionId!)}/review`, { decision, reason: reason.trim() || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setMode(null); setReason(""); setChoice(null);
      await refresh();
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: msg(cause, "The decision was not saved. Try again.") });
    }
  }
  const tone = d.state === "approved" ? "neutral" : d.state === "pending_review" ? "neutral" : "amber";
  const required = d.requiredFor.length > 0;
  return (
    <li className="py-2" data-testid="client-document" data-state={d.state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm font-semibold text-slate-900">{d.name} <span className="font-normal text-slate-600">{required ? `· for ${d.requiredFor.map((x) => x.serviceName).join(", ")}` : "· not required"}</span></p>
        <StatusChip tone={tone}>{DOC_STATE[d.state]}</StatusChip>
        <span className="text-xs text-slate-600 md:w-32">{d.expiresOn ? `Expires ${formatNumericDate(d.expiresOn)}` : d.requiresExpiry ? "No expiry set" : ""}</span>
        {canManage ? (
          <span className="flex gap-x-3">
            {d.state === "pending_review" ? <button type="button" className={linkCls} aria-expanded={mode === "review"} onClick={() => setMode(mode === "review" ? null : "review")}>Review…</button> : null}
            <button type="button" className={linkCls} aria-expanded={mode === "upload"} onClick={() => setMode(mode === "upload" ? null : "upload")}>{d.versionNumber ? "Upload a new version" : "Upload"}</button>
          </span>
        ) : null}
      </div>
      {d.versionNumber ? <p className="text-xs text-slate-600">Version {d.versionNumber} of {d.versionCount} · uploaded {d.uploadedAt ? formatNumericDate(d.uploadedAt) : ""}{d.uploadedByName ? ` by ${d.uploadedByName}` : ""}{d.reviewedByName ? ` · reviewed by ${d.reviewedByName}` : ""}</p> : null}
      {d.state === "rejected" && d.rejectionReason ? <p className="text-xs text-amber-900">Rejected: {d.rejectionReason}</p> : null}
      {d.state === "pending_review" ? <p className="text-xs text-slate-600">Uploading is not approval. It stays pending until a reviewer decides.</p> : null}
      {mode === "upload" ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700 sm:col-span-2">File (PDF, JPEG or PNG, up to 4 MB)<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className={field} /></label>
          <label className="text-sm font-medium text-slate-700">Issued (optional)<input type="date" value={issued} onChange={(e) => setIssued(e.target.value)} className={field} /></label>
          <label className="text-sm font-medium text-slate-700">Expires{d.requiresExpiry ? "" : " (optional)"}<input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={field} /></label>
          <div className="sm:col-span-2"><Button type="button" className="min-h-11" loading={state.busy} disabled={state.busy} onClick={() => void upload()}>Upload</Button></div>
        </div>
      ) : null}
      {mode === "review" ? (
        <div className="mt-2 space-y-2">
          <fieldset className="flex flex-wrap gap-x-5">
            <legend className="text-sm font-medium text-slate-700">Decision</legend>
            <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="radio" name={`decision-${d.documentTypeId}`} className="h-5 w-5" checked={choice === "verified"} onChange={() => setChoice("verified")} />Approve</label>
            <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="radio" name={`decision-${d.documentTypeId}`} className="h-5 w-5" checked={choice === "rejected"} onChange={() => setChoice("rejected")} />Reject</label>
          </fieldset>
          <label className="block text-sm font-medium text-slate-700">Reason (required to reject)<input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} className={field} /></label>
          <Button type="button" className="min-h-11" disabled={state.busy} onClick={() => void decide()}>Save decision</Button>
        </div>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
    </li>
  );
}

function DocumentSetup({ onDone }: { onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("consent");
  const [expiry, setExpiry] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const types = useQuery({
    queryKey: ["client-document-types", activeOrganizationId], enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ types: Array<{ documentTypeId: string; name: string; requiresExpiry: boolean; requiredFor: Array<{ serviceId: string; serviceName: string }> }> }>("/v1/client-document-types", { organizationId: activeOrganizationId })).types,
  });
  const services = useQuery({
    queryKey: ["aws-services"], enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ services: Array<{ serviceId: string; name: string; isActive: boolean }> }>("/v1/services", { organizationId: activeOrganizationId })).services,
  });
  const queryClient = useQueryClient();
  async function save() {
    if (name.trim().length < 2) return setState({ busy: false, error: "Give the document a name." });
    setState({ busy: true, error: null });
    try {
      await api.post("/v1/client-document-types", { organizationId: activeOrganizationId, name: name.trim(), category, requiresExpiry: expiry }, { idempotencyKey: newIdempotencyKey() });
      setName(""); await queryClient.invalidateQueries({ queryKey: ["client-document-types"] }); onDone();
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: msg(cause, "Not saved.") }); }
  }
  async function toggle(serviceId: string, typeId: string, required: boolean) {
    try {
      await api.post("/v1/client-document-requirements", { organizationId: activeOrganizationId, serviceId, documentTypeId: typeId, required }, { idempotencyKey: newIdempotencyKey() });
      await queryClient.invalidateQueries({ queryKey: ["client-document-types"] }); onDone();
    } catch (cause) { setState({ busy: false, error: msg(cause, "Not saved.") }); }
  }
  return (
    <div className="mt-2 space-y-3 rounded-lg bg-slate-50 p-3" data-testid="document-setup">
      <p className="text-sm text-slate-700">Choose which documents each service requires.</p>
      <ul className="space-y-2">
        {(types.data ?? []).map((t) => (
          <li key={t.documentTypeId} className="text-sm">
            <p className="font-semibold text-slate-900">{t.name}{t.requiresExpiry ? " (has an expiry date)" : ""}</p>
            <div className="flex flex-wrap gap-x-4">
              {(services.data ?? []).filter((s) => s.isActive).map((s) => {
                const on = t.requiredFor.some((x) => x.serviceId === s.serviceId);
                return <label key={s.serviceId} className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={on} onChange={(e) => void toggle(s.serviceId, t.documentTypeId, e.target.checked)} />Required for {s.name}</label>;
              })}
            </div>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">New document type<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={field} /></label>
        <label className="text-sm font-medium text-slate-700">Category<select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>{Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-700"><input type="checkbox" className="h-5 w-5" checked={expiry} onChange={(e) => setExpiry(e.target.checked)} />Has an expiry date</label>
        <div className="sm:col-span-2"><Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={() => void save()}>Add the document type</Button></div>
      </div>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
    </div>
  );
}

export function ClientDocumentsCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("documents.read");
  const canManage = hasPermission("documents.manage");
  const [setup, setSetup] = useState(false);
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["client-documents", clientId], enabled: !!activeOrganizationId && canRead,
    queryFn: async () => (await api.get<{ documents: ClientDoc[] }>(`/v1/clients/${encodeURIComponent(clientId)}/documents`, { organizationId: activeOrganizationId })).documents,
  });
  if (!canRead) return null;
  const docs = q.data ?? [];
  const todo = docs.filter((d) => d.state !== "approved" && d.requiredFor.length > 0).length;
  return (
    <SummarySection title="Documents" testId="client-documents" defaultOpen={todo > 0}
      status={q.data ? <StatusChip tone={todo > 0 ? "amber" : "neutral"}>{todo > 0 ? `${todo} to fix` : "All approved"}</StatusChip> : undefined}
      summary={q.data ? `${docs.length} document${docs.length === 1 ? "" : "s"}` : undefined}>
      {canManage ? <div className="mb-1 text-right"><button type="button" className={linkCls} aria-expanded={setup} onClick={() => setSetup((v) => !v)}>{setup ? "Close setup" : "Set up required documents"}</button></div> : null}
      {setup ? <DocumentSetup onDone={() => void queryClient.invalidateQueries({ queryKey: ["client-documents", clientId] })} /> : null}
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">The documents could not be loaded. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></p> : null}
      {q.data && docs.length === 0 ? <p className="text-sm text-slate-600">No documents are required or uploaded yet.</p> : null}
      <ul className="divide-y divide-slate-100">{docs.map((d) => <DocRow key={d.documentTypeId} d={d} clientId={clientId} canManage={canManage} />)}</ul>
    </SummarySection>
  );
}

// ---------------------------------------------------------------- alerts (6, 7), next visits (9, 10), history (12)
/** One row per identical action and severity, with a count, so the same sentence is not repeated down the page. */
function groupAlerts<T extends { severity: string; recommendedAction: string; issueKey: string }>(items: T[]): Array<[T, number]> {
  const out = new Map<string, [T, number]>();
  for (const i of items) {
    const k = `${i.severity}|${i.recommendedAction}`;
    const e = out.get(k);
    if (e) e[1] += 1; else out.set(k, [i, 1]);
  }
  return [...out.values()];
}

/** The overall outcome first ("Ready for scheduling" / "Not ready: 2 items to fix"), then each item to fix with its one action. */
export function ClientAlertsCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("visits.read") || hasPermission("shifts.manage") || hasPermission("documents.read");
  const q = useQuery({
    queryKey: ["client-issues", clientId], enabled: !!activeOrganizationId && allowed,
    queryFn: async () => api.get<IssueList>("/v1/action-issues", { organizationId: activeOrganizationId, clientId, limit: "50" }),
  });
  const hist = useQuery({
    queryKey: ["client-issue-history", clientId], enabled: !!activeOrganizationId && allowed,
    queryFn: async () => (await api.get<{ history: { resolved: Array<{ issueKey: string; kind: string; reason: string; firstSeenAt: string; resolvedAt: string }> } }>(`/v1/clients/${encodeURIComponent(clientId)}/issue-history`, { organizationId: activeOrganizationId })).history.resolved,
  });
  const readiness = useClientReadiness(clientId);
  if (!allowed) return null;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">This client&apos;s alerts could not be loaded, so they are not shown as empty. Reload the page.</p>;
  const open = q.data?.issues ?? [];
  if (!q.data) return null;
  const blocked = readiness.data ? !readiness.data.canSchedule : false;
  const ready = open.length === 0 && !blocked;
  return (
    <section aria-label="Client alerts" data-testid="client-alerts" className="space-y-2">
      <p data-testid="client-outcome" className={`text-base font-semibold ${ready ? "text-emerald-800" : "text-amber-900"}`}>
        {ready ? "Ready for scheduling" : open.length > 0 ? `Not ready: ${open.length} item${open.length === 1 ? "" : "s"} to fix` : "Not ready: activate this client to schedule"}
      </p>
      {open.length > 0 ? (
        <ul className="space-y-2">
          {groupAlerts(open).map(([i, n]) => {
            const dest = issueDestination(i);
            const tone = i.severity === "critical" ? "red" : i.severity === "urgent" ? "amber" : "neutral";
            return (
              <li key={i.issueKey} data-testid="client-alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-og-card p-3 text-sm">
                <StatusChip tone={tone}>{TONE[tone].word}</StatusChip>
                <span className="min-w-0 flex-1 text-slate-900">{i.recommendedAction}{n > 1 ? ` (${n} items)` : ""}</span>
                <Link className={linkCls} to={`${dest.to}${dest.to.includes("?") ? "&" : "?"}client=${encodeURIComponent(clientId)}`}>{dest.label}</Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {(hist.data ?? []).length > 0 ? (
        <details data-testid="client-alert-history">
          <summary className="cursor-pointer text-sm text-slate-700">Resolved alerts ({hist.data!.length})</summary>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{hist.data!.map((h) => <li key={h.issueKey}>{formatNumericDate(h.firstSeenAt)} to {formatNumericDate(h.resolvedAt)} · {h.reason.replace(/_/g, " ")}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

export function ClientQuickActions({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const { hasPermission } = useOrganization();
  const manage = hasPermission("shifts.manage");
  const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-semibold hover:opacity-90";
  return (
    <nav aria-label="Client actions" className="flex flex-wrap items-center gap-2">
      {manage ? <Link to={`/schedule?add=1&client=${encodeURIComponent(clientId)}`} className={`${btn} bg-og-accent text-og-on-accent`}>Schedule Visit</Link> : null}
      <details className="relative">
        <summary className={`${btn} cursor-pointer list-none border border-og-line bg-og-card text-og-ink [&::-webkit-details-marker]:hidden`}>More</summary>
        <ul className="mt-1 min-w-[200px] space-y-0.5 rounded-lg border border-og-line bg-og-card p-2 text-sm md:absolute md:z-10">
          <li><a className={linkCls} href="#authorizations">View Authorization</a></li>
          {hasPermission("visits.read") ? <li><Link className={linkCls} to={`/visit-review?client=${encodeURIComponent(clientId)}`}>Verify Visit</Link></li> : null}
          <li><a className={linkCls} href="#readiness">Readiness and holds</a></li>
          {hasPermission("documents.read") ? <li><a className={linkCls} href="#documents">Documents</a></li> : null}
          <li><a className={linkCls} href="#history">History</a></li>
          {canEdit ? <li><a className={linkCls} href="#details">Edit details</a></li> : null}
        </ul>
      </details>
    </nav>
  );
}

const STATE_WORD: Record<string, string> = { covered: "Scheduled", needs_coverage: "Needs a caregiver", cancelled: "Cancelled", completed: "Completed", no_show: "No-show" };
export function NextVisitsCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { today } = useAgencyClock();
  const allowed = hasPermission("shifts.manage") || hasPermission("visits.manage");
  const to = agencyDateOffset(today, 60);
  const q = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, today, to, clientId], enabled: !!activeOrganizationId && allowed,
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from: today, to, clientId })).shifts,
  });
  if (!allowed) return null;
  const upcoming = (q.data ?? []).filter((s) => Date.parse(s.endsAt) > Date.now() && s.coverageState !== ("cancelled" as string)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 3);
  return (
    <SummarySection title="Next visits" testId="next-visits" defaultOpen={q.data !== undefined && upcoming.length > 0 && upcoming.some((s) => s.coverageState === "needs_coverage")}
      summary={q.data ? (upcoming.length === 0 ? "None in the next 60 days" : `Next: ${formatNumericDate(upcoming[0]!.startsAt)} ${formatClockTime(upcoming[0]!.startsAt)}`) : undefined}>
      <div className="mb-1 text-right"><Link className={linkCls} to={`/schedule?client=${encodeURIComponent(clientId)}`}>Full schedule</Link></div>
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">The visits could not be loaded, so they are not shown as none. Reload the page.</p> : null}
      {q.data && upcoming.length === 0 ? <p className="text-sm text-slate-600">No visits are scheduled in the next 60 days.</p> : null}
      <ul className="space-y-1">
        {upcoming.map((s) => (
          <li key={s.shiftId} className="flex flex-wrap items-center gap-x-3 text-sm" data-testid="next-visit">
            <span className="font-og-mono tabular-nums text-slate-900">{formatNumericDate(s.startsAt)} {formatClockTime(s.startsAt)}–{formatClockTime(s.endsAt)}</span>
            <span className="text-slate-700">{s.coverageState === "needs_coverage" ? "No caregiver" : (s.caregiverName ?? s.caregiverCode ?? "Caregiver assigned")}</span>
            <span className="text-slate-600">{STATE_WORD[s.coverageState] ?? s.coverageState}</span>
          </li>
        ))}
      </ul>
    </SummarySection>
  );
}

export function ClientHistoryCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("clients.manage") || hasPermission("authorizations.update") || hasPermission("visits.manage");
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["client-audit", clientId], enabled: !!activeOrganizationId && allowed && open,
    queryFn: async () => (await api.get<{ events: Array<{ occurredAt: string; action: string; actorName: string | null; reason: string | null; fields: string[] }> }>(`/v1/clients/${encodeURIComponent(clientId)}/audit`, { organizationId: activeOrganizationId })).events,
  });
  if (!allowed) return null;
  return (
    <Card className="px-4 py-1" data-testid="client-history">
      <button type="button" className="min-h-[44px] text-base font-semibold text-slate-950" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide history" : "History and audit trail"}</button>
      {open ? (
        <div className="mt-2">
          {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
          {q.isError ? <p role="alert" className="text-sm text-red-700">The history could not be loaded.</p> : null}
          <ul className="space-y-1 text-sm">
            {(q.data ?? []).map((e, n) => <li key={n} className="text-slate-800">{formatNumericDate(e.occurredAt)} {formatClockTime(e.occurredAt)} · {e.action.replace(/[._]/g, " ")}{e.actorName ? ` · ${e.actorName}` : ""}{e.fields.length ? ` · changed: ${e.fields.join(", ").replace(/_/g, " ")}` : ""}{e.reason ? ` · ${e.reason}` : ""}</li>)}
          </ul>
          {q.data && q.data.length === 0 ? <p className="text-sm text-slate-600">No history yet.</p> : null}
          <p className="mt-2 text-xs text-slate-600">Shows what changed and who changed it, never the values.</p>
        </div>
      ) : null}
    </Card>
  );
}

/** Compact caregivers: name, assignment status and next visit; the full assignment tools open on selection (B2-D9). */
export function CaregiverSummary({ clientId, children }: { clientId: string; children: React.ReactNode }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { today } = useAgencyClock();
  const to = agencyDateOffset(today, 60);
  const [open, setOpen] = useState(false);
  const assignments = useAssignments({ clientId });
  const shifts = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, today, to, clientId], enabled: !!activeOrganizationId && (hasPermission("shifts.manage") || hasPermission("visits.manage")),
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from: today, to, clientId })).shifts,
  });
  const next = (rec: string | null) => (shifts.data ?? []).filter((s) => s.caregiverRecordId === rec && Date.parse(s.endsAt) > Date.now()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  const current = (assignments.data ?? []).filter((a) => a.state !== "ended");
  const byCaregiver = new Map<string, typeof current>();
  for (const a of current) byCaregiver.set(a.caregiverRecordId ?? a.assignmentId, [...(byCaregiver.get(a.caregiverRecordId ?? a.assignmentId) ?? []), a]);
  const groups = [...byCaregiver.values()];
  return (
    <SummarySection title="Caregivers" testId="caregiver-summary" defaultOpen={assignments.data !== undefined && current.length === 0}
      summary={assignments.data ? (current.length === 0 ? "None assigned" : `${groups.length} assigned`) : undefined}>
      <div className="mb-1 text-right"><button type="button" className={linkCls} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide assignment details" : "Assignment details"}</button></div>
      {assignments.isError ? <p role="alert" className="text-sm text-red-700">The caregivers could not be loaded. Reload the page.</p> : null}
      {assignments.data && current.length === 0 ? <p className="text-sm text-slate-600">No caregiver is assigned yet.</p> : null}
      <ul className="space-y-1">
        {groups.map((list) => {
          const a = list[0]!;
          const n = next(a.caregiverRecordId);
          return (
            <li key={a.assignmentId} className="flex flex-wrap items-center gap-x-3 text-sm" data-testid="caregiver-summary-row">
              <span className="font-semibold text-slate-900">{a.caregiverName ?? a.caregiverCode ?? "Caregiver"}</span>
              <span className="text-slate-600">{a.state === "current" ? "Assigned" : "Starts " + formatNumericDate(a.effectiveStart)} · {list.map((x) => x.serviceCode).join(", ")}</span>
              <span className="text-slate-600">{n ? `Next visit ${formatNumericDate(n.startsAt)} ${formatClockTime(n.startsAt)}` : "No visit scheduled"}</span>
            </li>
          );
        })}
      </ul>
      {open ? <div className="mt-3">{children}</div> : null}
    </SummarySection>
  );
}
