import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { prepareDocumentFile } from "./document-file";
import { Link } from "react-router-dom";
import { documentDateLine, documentStatusLabel, isDueSoon, isOverdue, isToReview, matchesFilter, parseReminderDays, uploadFailureMessage, type DocumentFilter, type DocumentType, type Person, type StaffDocument } from "./document-status";
import { useAttentionOverview } from "./attention";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";
import { formatDateTime } from "@/lib/service-verification";
import { ShortHelp } from "./help-text";
import { actionBtn, actionBtnPrimary, linkClass } from "./ui-classes";


const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Upload form: the file is stored and recorded by the server before success is shown. */
function UploadForm({ doc, onDone }: { doc: StaffDocument; onDone: (savedMessage: string) => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [file, setFile] = useState<File | null>(null);
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  // One key per upload attempt: a retry after a lost response cannot add a second version.
  const key = useRef(newIdempotencyKey());

  async function submit() {
    if (!file) return setState({ busy: false, error: "Choose a photo or PDF of the document." });
    if (doc.requiresExpiry && !expiresOn) return setState({ busy: false, error: "Enter the expiry date shown on the document." });
    if (issuedOn && expiresOn && expiresOn <= issuedOn) return setState({ busy: false, error: "The expiry date is before the issue date. Correct one of the dates." });
    setState({ busy: true, error: null });
    try {
      const prepared = await prepareDocumentFile(file);
      await api.post(
        `/v1/documents/${encodeURIComponent(doc.documentId)}/versions`,
        { organizationId: activeOrganizationId, contentType: prepared.contentType, fileBase64: prepared.base64, issuedOn: issuedOn || null, expiresOn: expiresOn || null },
        { idempotencyKey: key.current },
      );
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null });
      onDone("Saved. The file and its dates were stored and recorded by the server.");
    } catch (cause) {
      setState({ busy: false, error: uploadFailureMessage(cause) });
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
      <label className="block text-sm font-medium text-slate-700">
        Photo or PDF of the {doc.documentTypeName}
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); key.current = newIdempotencyKey(); }}
          className="mt-1 block w-full text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm font-medium text-slate-700">
          Issue / completion date
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Expiry date{doc.requiresExpiry ? " (required)" : " (if any)"}
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      <Button type="submit" className="min-h-[44px] md:min-h-[40px]" disabled={state.busy}>{state.busy ? "Saving… keep this page open" : "Save document"}</Button>
    </form>
  );
}

function OpenFileButton({ versionId }: { versionId: string }) {
  const api = useAwsApi();
  const [state, setState] = useState<{ busy: boolean; error: string | null; url: string | null; type: string | null }>({ busy: false, error: null, url: null, type: null });
  async function open() {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await api.get<{ contentType: string; fileBase64: string }>(`/v1/document-versions/${encodeURIComponent(versionId)}/file`);
      const bytes = Uint8Array.from(atob(r.fileBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
      setState({ busy: false, error: null, url, type: r.contentType });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Could not open the file."), url: null, type: null });
    }
  }
  return (
    <div>
      <button type="button" onClick={() => void open()} disabled={state.busy} className={actionBtn}>
        {state.busy ? "Opening…" : "View"}
      </button>
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
      {state.url ? (
        <p className="mt-1 text-sm">
          {state.type?.startsWith("image/") ? <img src={state.url} alt="Uploaded document" className="mt-1 max-h-64 rounded border border-slate-200" /> : null}
          <a href={state.url} target="_blank" rel="noreferrer" className={linkClass}>Open in a new tab</a>
        </p>
      ) : null}
    </div>
  );
}

/** Approve / Reject for an authorised reviewer. Approve saves at once; Reject asks for the reason first. The server still decides who may review (self-review, CPR/TB). */
function useReviewDecision(doc: StaffDocument, onSaved: (savedMessage: string) => void) {
  const api = useAwsApi();
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function decide(choice: "verified" | "rejected") {
    if (choice === "rejected" && !reason.trim()) return setState({ busy: false, error: "Reason missing. Enter why it is rejected, so the person knows what to fix." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/document-versions/${encodeURIComponent(doc.latestVersionId!)}/review`, { decision: choice, reason: reason.trim() || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null });
      setRejecting(false);
      setReason("");
      onSaved(choice === "verified" ? "Saved. Approved: your name and the time are recorded." : "Saved. Rejected: the reason is recorded and the person can upload a replacement.");
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The review was not saved. Try again.") });
    }
  }
  return { reason, setReason, rejecting, setRejecting, busy: state.busy, error: state.error, approve: () => decide("verified"), reject: () => decide("rejected") };
}

function DocumentRows({ d, canManage, canUpload, canReviewOwn, canReview, refresh }: { d: StaffDocument; canManage: boolean; canUpload: boolean; canReviewOwn: boolean; canReview: boolean; refresh: () => void }) {
  const [mode, setMode] = useState<"upload" | null>(null);
  // Shown until the next action so a saved upload or decision is never silent (the status chip also changes on refresh).
  const [saved, setSaved] = useState<string | null>(null);
  const review = useReviewDecision(d, (m) => { setSaved(m); refresh(); });
  const line = documentDateLine(d);
  const status = documentStatusLabel(d);
  const uploadLabel = d.latestVersionId ? "Replace" : canManage ? "Upload for them" : "Upload";
  const awaiting = canManage && d.latestReviewStatus === "awaiting_review";
  const reviewable = awaiting && canReview && !(d.latestUploadedByMe && !canReviewOwn);
  const btn = actionBtn;
  const hasExtra = !!(saved || review.error || mode || (reviewable && review.rejecting) || (d.latestReviewStatus === "rejected" && d.latestRejectionReason) || (awaiting && (!canReview || d.latestUploadedByMe)));
  return (
    <tbody className="border-t border-og-line">
      <tr className="block align-top md:table-row">
        <th scope="row" className="block py-2 pr-2 text-left font-normal md:table-cell">
          <p className="font-semibold text-og-ink">{d.documentTypeName}</p>
          {canManage ? <p className="text-sm text-og-sub">{d.personName}</p> : null}
          <Disclosure summary="Details">
            <dl className="space-y-1 text-xs">
              {line ? <div><dt className="inline font-semibold text-og-ink">Date: </dt><dd className="inline">{line}</dd></div> : null}
              {d.latestUploadedAt ? <div><dt className="inline font-semibold text-og-ink">Uploaded: </dt><dd className="inline">Version {d.latestVersionNumber}, {formatDateTime(d.latestUploadedAt)}</dd></div> : null}
              {d.reviewedByName && d.reviewedAt ? <div><dt className="inline font-semibold text-og-ink">Reviewed: </dt><dd className="inline">{d.reviewedByName}, {formatDateTime(d.reviewedAt)}</dd></div> : null}
              {d.currencyStatus === "expiring" && d.reminderStage ? <div><dt className="inline font-semibold text-og-ink">Reminder: </dt><dd className="inline">within {d.reminderStage} days of expiry (shown here; Ogevia sends no email or text reminders)</dd></div> : null}
              {d.currencyStatus === "no_expiry_required" ? <div>This document type has no expiry date.</div> : null}
              {!d.latestUploadedAt && !line ? <div>Nothing uploaded yet.</div> : null}
              <div>Earlier versions are kept; a replacement never overwrites them.</div>
              <div>Approving records your name and the time; it is an administrative check, not legal clearance.</div>
            </dl>
          </Disclosure>
        </th>
        <td className="block pb-1 md:table-cell md:py-2 md:pr-2"><StatusChip tone={status.tone}>{status.label}</StatusChip></td>
        <td className="block pb-2 md:table-cell md:py-2">
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {reviewable && !review.rejecting ? <button type="button" disabled={review.busy} onClick={() => { setSaved(null); void review.approve(); }} className={actionBtnPrimary}>{review.busy ? "Saving…" : "Approve"}</button> : null}
            {reviewable && !review.rejecting ? <button type="button" disabled={review.busy} onClick={() => { setSaved(null); review.setRejecting(true); }} className={btn}>Reject</button> : null}
            {d.latestVersionId ? <OpenFileButton versionId={d.latestVersionId} /> : null}
            {canUpload ? <button type="button" aria-expanded={mode === "upload"} onClick={() => { setSaved(null); setMode(mode === "upload" ? null : "upload"); }} className={btn}>{mode === "upload" ? "Cancel" : uploadLabel}</button> : null}
          </div>
        </td>
      </tr>
      {hasExtra ? <tr>
        <td colSpan={3} className="pb-2">
          {d.latestReviewStatus === "rejected" && d.latestRejectionReason ? <p className="text-sm text-amber-900">Rejected: {d.latestRejectionReason}</p> : null}
          {awaiting && !canReview ? <p className="text-sm text-og-sub">Required CPR and TB records need Administrator verification. Review controls appear only after the requirement rules are loaded.</p> : null}
          {reviewable && d.latestUploadedByMe ? <p className="text-xs font-semibold text-amber-900">You uploaded this version. Your approval is recorded as an Administrator self-review.</p> : null}
          {awaiting && canReview && d.latestUploadedByMe && !canReviewOwn ? <p className="rounded-lg bg-og-page p-2 text-sm text-og-sub">You uploaded this version, so the Administrator or another manager must review it.</p> : null}
          {mode === "upload" ? <UploadForm doc={d} onDone={(m) => { setMode(null); setSaved(m); refresh(); }} /> : null}
          {reviewable && review.rejecting ? (
            <form onSubmit={(e) => { e.preventDefault(); void review.reject(); }} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
              <label className="min-w-[12rem] flex-1 text-sm font-medium text-slate-700">
                Reason for rejecting (required)
                <input value={review.reason} maxLength={1000} onChange={(e) => review.setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </label>
              <Button type="submit" className="min-h-[44px] md:min-h-[40px]" disabled={review.busy}>{review.busy ? "Saving…" : "Save rejection"}</Button>
              <button type="button" className={btn} onClick={() => { review.setRejecting(false); review.setReason(""); }}>Cancel</button>
            </form>
          ) : null}
          {review.error ? <p role="alert" className="mt-1 text-sm text-red-700">{review.error}</p> : null}
          {saved ? <p role="status" className="mt-1 text-sm font-medium text-emerald-800" data-testid="document-saved">{saved}</p> : null}
        </td>
      </tr> : null}
    </tbody>
  );
}

function RequestForm({ types, people, onDone }: { types: DocumentType[]; people: Person[]; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [person, setPerson] = useState("");
  const [type, setType] = useState("");
  const [due, setDue] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (!person || !type) return setState({ busy: false, error: "Choose a person and a document type.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post("/v1/documents/requests", { organizationId: activeOrganizationId, caregiverRecordId: person, documentTypeId: type, dueOn: due || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null, done: true });
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The request was not saved."), done: false });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-wrap items-end gap-3">
      <div className="text-sm font-medium text-slate-700">
        <label htmlFor="doc-request-person">Person</label>
        <select id="doc-request-person" value={person} onChange={(e) => setPerson(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
          <option value="">Choose…</option>
          {people.map((p) => <option key={p.caregiverRecordId} value={p.caregiverRecordId}>{p.displayName}</option>)}
        </select>
      </div>
      <div className="text-sm font-medium text-slate-700">
        <label htmlFor="doc-request-type">Document</label>
        <select id="doc-request-type" value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
          <option value="">Choose…</option>
          {types.filter((t) => t.isActive).map((t) => <option key={t.documentTypeId} value={t.documentTypeId}>{t.name}</option>)}
        </select>
      </div>
      <label className="text-sm font-medium text-slate-700">
        Due date (optional)
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
      </label>
      <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Request document"}</Button>
      {state.error ? <p role="alert" className="w-full text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="w-full text-sm text-emerald-800">Requested. It appears in their My documents.</p> : null}
    </form>
  );
}

/** Reminder days before expiry: the agency default and per-type overrides (0033). Screens only: nothing is emailed or texted. */
function ReminderDaysForm({ types, onDone }: { types: DocumentType[]; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [typeId, setTypeId] = useState("");
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  const expiring = types.filter((t) => t.requiresExpiry);
  async function save() {
    const days = text.trim() === "" && typeId ? null : parseReminderDays(text);
    if (days === null && !(text.trim() === "" && typeId)) {
      return setState({ busy: false, error: "Enter 1 to 8 different whole numbers of days from 1 to 365, for example 90, 60, 30, 14, 7.", done: null });
    }
    setState({ busy: true, error: null, done: null });
    try {
      await api.post("/v1/document-reminder-days", { organizationId: activeOrganizationId, documentTypeId: typeId || null, days }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null, done: days ? `Saved: ${days.join(", ")} days.` : "Saved: this type uses the agency default." });
      setText("");
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The reminder days were not saved."), done: null });
    }
  }
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <h2 className="text-sm font-semibold text-slate-900">Reminder days before expiry</h2>
      <ShortHelp className="text-xs text-slate-500" details="A verified document shows as Expiring once it is within the largest number of days.">These days decide when a document shows as Expiring and what Action needed shows. Ogevia does not send email or text reminders.</ShortHelp>
      {expiring.length > 0 ? (
        <ul className="space-y-1 text-xs text-slate-700">
          {expiring.map((t) => (
            <li key={t.documentTypeId}>{t.name}: {(t.reminderDays ?? []).join(", ")} days{t.usesAgencyDefault ? " (agency default)" : ""}</li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-slate-700">
          Applies to
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm">
            <option value="">Agency default</option>
            {expiring.map((t) => <option key={t.documentTypeId} value={t.documentTypeId}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Days (e.g. 90, 60, 30, 14, 7)
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={typeId ? "blank = agency default" : "90, 60, 30, 14, 7"} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <Button type="submit" variant="secondary" disabled={state.busy}>Save reminder days</Button>
      </form>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
    </div>
  );
}

function TypesForm({ types, onDone }: { types: DocumentType[]; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [name, setName] = useState("");
  const [requiresExpiry, setRequiresExpiry] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (name.trim().length < 2) return setState({ busy: false, error: "Enter a document type name." });
    setState({ busy: true, error: null });
    try {
      await api.post("/v1/document-types", { organizationId: activeOrganizationId, name: name.trim(), requiresExpiry }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setName("");
      setRequiresExpiry(false);
      setState({ busy: false, error: null });
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The type was not saved.") });
    }
  }
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-2">
        {types.map((t) => (
          <li key={t.documentTypeId} className="rounded-full border border-slate-200 bg-og-card px-3 py-1 text-xs text-slate-700">
            {t.name}{t.requiresExpiry ? " · expiry required" : ""}
          </li>
        ))}
        {types.length === 0 ? <li className="text-sm text-slate-500">No document types yet.</li> : null}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-slate-700">
          New type
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. CPR card" className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="h-5 w-5" checked={requiresExpiry} onChange={(e) => setRequiresExpiry(e.target.checked)} />
          Has an expiry date (use the date on the certificate)
        </label>
        <Button type="submit" variant="secondary" disabled={state.busy}>Add type</Button>
        {state.error ? <p role="alert" className="w-full text-sm text-red-700">{state.error}</p> : null}
      </form>
    </div>
  );
}

/**
 * Documents & Compliance (AWS TEST, 0021). Managers request, review and
 * configure; caregivers see and upload only their own requested documents.
 */
export function DocumentsPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("documents.read");
  const canManage = hasPermission("documents.manage");
  const canOwn = hasPermission("documents.manage_own");
  const canVerifyRequired = hasPermission("documents.requirements.manage");
  const requirementRules = useQuery({
    queryKey: ["document-requirements", activeOrganizationId],
    queryFn: async () => (await api.get<{ setup: { requirements: { documentTypeId: string | null }[] } }>("/v1/document-requirements", { organizationId: activeOrganizationId })).setup.requirements,
    enabled: !!activeOrganizationId && canManage && !canVerifyRequired,
  });
  const docs = useQuery({
    queryKey: ["aws-documents", activeOrganizationId],
    queryFn: async () => (await api.get<{ documents: StaffDocument[] }>("/v1/documents", { organizationId: activeOrganizationId })).documents,
    enabled: !!activeOrganizationId && (canRead || canOwn),
  });
  const types = useQuery({
    queryKey: ["aws-document-types", activeOrganizationId],
    queryFn: async () => (await api.get<{ types: DocumentType[] }>("/v1/document-types", { organizationId: activeOrganizationId })).types,
    enabled: !!activeOrganizationId && canManage,
  });
  const people = useQuery({
    queryKey: ["aws-document-people", activeOrganizationId],
    queryFn: async () => (await api.get<{ people: Person[] }>("/v1/documents/people", { organizationId: activeOrganizationId })).people,
    enabled: !!activeOrganizationId && canManage,
  });
  const overview = useAttentionOverview();
  const [filter, setFilter] = useState<DocumentFilter>("all");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["aws-documents"] });
    void queryClient.invalidateQueries({ queryKey: ["aws-document-types"] });
    void queryClient.invalidateQueries({ queryKey: ["aws-document-alerts"] });
    void queryClient.invalidateQueries({ queryKey: ["attention-overview"] });
  };

  if (!canRead && !canOwn) return <p className="text-sm text-og-sub">You do not have access to documents.</p>;

  const list = docs.data ?? [];
  const shown = canRead ? list.filter((d) => matchesFilter(d, filter)) : list;
  const counts = { all: list.length, overdue: list.filter(isOverdue).length, due_soon: list.filter(isDueSoon).length, to_review: list.filter(isToReview).length };
  const FILTERS: { key: DocumentFilter; label: string }[] = [{ key: "all", label: "All" }, { key: "overdue", label: "Overdue" }, { key: "due_soon", label: "Due soon" }, ...(canManage ? [{ key: "to_review" as const, label: "To review" }] : [])];
  const holds = overview.data?.documents?.caregiversOnHold ?? 0;
  const pending = overview.data?.documents?.caregiversWithPendingRequirements ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={canRead ? "Documents & compliance" : "My documents"}
        lead={canRead ? "Staff credentials and their status. Uploaded is not verified until someone reviews it." : "Documents your agency has asked for. Take a clear photo or choose a PDF, add the dates on it, and upload."}
      />

      {canRead && (holds > 0 || pending > 0) ? (
        <p role="status" className="flex flex-wrap items-center gap-x-3 rounded-og border border-amber-600 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="compliance-strip">
          <span><span aria-hidden="true">▲ </span>{holds > 0 ? `${holds} ${holds === 1 ? "caregiver is" : "caregivers are"} on a compliance hold` : null}{holds > 0 && pending > 0 ? " · " : null}{pending > 0 ? `${pending} with requirements pending` : null}</span>
          <Link className="inline-flex min-h-[44px] items-center font-semibold underline md:min-h-[32px]" to="/compliance">Review compliance</Link>
        </p>
      ) : null}

      {canManage ? (
        <Disclosure summary="Request a document" className="rounded-og border border-og-line bg-og-card px-3">
          <RequestForm types={types.data ?? []} people={people.data ?? []} onDone={refresh} />
        </Disclosure>
      ) : null}

      {canRead ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`min-h-[44px] rounded-lg px-3 text-sm font-medium md:min-h-[40px] ${filter === f.key ? "bg-og-accent text-og-on-accent" : "border border-og-line text-og-ink hover:bg-og-page"}`}>
              {f.label} <span className="font-og-mono tabular-nums">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {docs.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {docs.isError ? <p role="alert" className="text-sm text-red-700">{(docs.error as Error).message}</p> : null}
      {!docs.isLoading && !docs.isError && shown.length === 0 ? (
        <p className="text-sm text-og-sub">{canRead ? (filter === "all" ? "No documents requested yet." : "No documents match this filter.") : "Your agency has not requested any documents."}</p>
      ) : null}
      {shown.length > 0 ? (
      <table className="w-full text-sm" aria-label="Documents">
        <thead>
          <tr className="hidden text-left text-xs uppercase tracking-wide text-og-sub md:table-row">
            <th scope="col" className="py-1 pr-2 font-semibold">Document</th>
            <th scope="col" className="py-1 pr-2 font-semibold">Status</th>
            <th scope="col" className="py-1 text-right font-semibold">Action</th>
          </tr>
        </thead>
        {shown.map((d) => (
          <DocumentRows key={d.documentId} d={d} canManage={canManage} canUpload={canManage || canOwn} canReviewOwn={hasPermission("documents.review_own")} canReview={canVerifyRequired || (!!requirementRules.data && !requirementRules.data.some((r) => r.documentTypeId === d.documentTypeId))} refresh={refresh} />
        ))}
      </table>
      ) : null}

      {canManage ? (
        <Disclosure summary="Document types and reminder days" className="rounded-og border border-og-line bg-og-card px-3">
          <div className="space-y-3 pb-2">
            <p className="text-xs">Set expiry only where the document has one. Reminder periods follow your agency's own requirements.</p>
            <TypesForm types={types.data ?? []} onDone={refresh} />
            <ReminderDaysForm types={types.data ?? []} onDone={refresh} />
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
