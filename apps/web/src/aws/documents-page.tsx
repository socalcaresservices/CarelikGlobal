import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { prepareDocumentFile } from "./document-file";
import { DOCUMENT_STATUS, documentDateLine, type DocumentType, type Person, type StaffDocument } from "./document-status";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function StatusChip({ status }: { status: StaffDocument["displayStatus"] }) {
  const s = DOCUMENT_STATUS[status];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${s.className}`}>{s.label}</span>;
}

/** Upload form: the file is stored and recorded by the server before success is shown. */
function UploadForm({ doc, onDone }: { doc: StaffDocument; onDone: () => void }) {
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
    if (issuedOn && expiresOn && expiresOn <= issuedOn) return setState({ busy: false, error: "The expiry date must be after the issue date." });
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
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The upload did not finish. Nothing was saved; try again.") });
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
      <Button type="submit" disabled={state.busy}>{state.busy ? "Uploading… keep this page open" : "Upload"}</Button>
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
      <button type="button" onClick={() => void open()} disabled={state.busy} className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800">
        {state.busy ? "Opening…" : "Open file"}
      </button>
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
      {state.url ? (
        <p className="mt-1 text-sm">
          {state.type?.startsWith("image/") ? <img src={state.url} alt="Uploaded document" className="mt-1 max-h-64 rounded border border-slate-200" /> : null}
          <a href={state.url} target="_blank" rel="noreferrer" className="text-sky-700 underline">Open in a new tab</a>
        </p>
      ) : null}
    </div>
  );
}

function ReviewControls({ doc, selfReview, onDone }: { doc: StaffDocument; selfReview: boolean; onDone: () => void }) {
  const api = useAwsApi();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function decide(decision: "verified" | "rejected") {
    if (decision === "rejected" && !reason.trim()) return setState({ busy: false, error: "Enter why it is rejected, so the person knows what to fix." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/document-versions/${encodeURIComponent(doc.latestVersionId!)}/review`, { decision, reason: reason.trim() || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null });
      onDone();
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The review was not saved.") });
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-600">Check the file and its dates. Verifying records your name and the time; it is an administrative check, not legal clearance.</p>
      {selfReview ? <p className="text-xs font-semibold text-amber-900">You uploaded this version. Your review is recorded as an Administrator self-review.</p> : null}
      <label className="block text-sm font-medium text-slate-700">
        Reason (required to reject)
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
      </label>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={state.busy} onClick={() => void decide("verified")}>Verify</Button>
        <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void decide("rejected")}>Reject</Button>
      </div>
    </div>
  );
}

function DocumentCard({ d, canManage, canUpload, canReviewOwn, refresh }: { d: StaffDocument; canManage: boolean; canUpload: boolean; canReviewOwn: boolean; refresh: () => void }) {
  const [mode, setMode] = useState<"upload" | null>(null);
  const line = documentDateLine(d);
  const uploadLabel = d.latestVersionId ? "Upload a new version" : "Upload";
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-slate-950">{d.documentTypeName}</p>
          {canManage ? <p className="text-sm text-slate-700">{d.personName}</p> : null}
        </div>
        <StatusChip status={d.displayStatus} />
      </div>
      {line ? <p className={d.daysUntil !== null && d.daysUntil < 0 ? "mt-1 text-sm font-semibold text-red-700" : "mt-1 text-sm text-slate-700"}>{line}</p> : null}
      {d.latestReviewStatus === "rejected" && d.latestRejectionReason ? <p className="mt-1 text-sm text-amber-900">Rejected: {d.latestRejectionReason}</p> : null}
      {d.latestUploadedAt ? (
        <p className="mt-1 text-xs text-slate-500">Version {d.latestVersionNumber} uploaded {new Date(d.latestUploadedAt).toLocaleString("en-US")}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {d.latestVersionId ? <OpenFileButton versionId={d.latestVersionId} /> : null}
        {canUpload ? (
          <button type="button" onClick={() => setMode(mode === "upload" ? null : "upload")} className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800">
            {mode === "upload" ? "Cancel upload" : canManage && !d.latestVersionId ? "Upload on their behalf" : uploadLabel}
          </button>
        ) : null}
      </div>
      {mode === "upload" ? <UploadForm doc={d} onDone={() => { setMode(null); refresh(); }} /> : null}
      {canManage && d.latestReviewStatus === "awaiting_review" ? (
        d.latestUploadedByMe && !canReviewOwn ? (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">You uploaded this version, so the Administrator or another manager must review it.</p>
        ) : (
          <ReviewControls doc={d} selfReview={!!d.latestUploadedByMe} onDone={refresh} />
        )
      ) : null}
    </li>
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
        <select id="doc-request-person" value={person} onChange={(e) => setPerson(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
          <option value="">Choose…</option>
          {people.map((p) => <option key={p.caregiverRecordId} value={p.caregiverRecordId}>{p.displayName}</option>)}
        </select>
      </div>
      <div className="text-sm font-medium text-slate-700">
        <label htmlFor="doc-request-type">Document</label>
        <select id="doc-request-type" value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
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
          <li key={t.documentTypeId} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
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
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={requiresExpiry} onChange={(e) => setRequiresExpiry(e.target.checked)} />
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
  const [filter, setFilter] = useState<"attention" | "all">("attention");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["aws-documents"] });
    void queryClient.invalidateQueries({ queryKey: ["aws-document-types"] });
    void queryClient.invalidateQueries({ queryKey: ["aws-document-alerts"] });
  };

  if (!canRead && !canOwn) return <p className="text-sm text-slate-600">You do not have access to documents.</p>;

  const list = docs.data ?? [];
  const needsAction = (d: StaffDocument) => d.displayStatus !== "verified";
  const shown = canRead && filter === "attention" ? list.filter(needsAction) : list;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-950">{canRead ? "Documents" : "My documents"}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {canRead
            ? "Staff credentials your agency has requested. Uploaded is not verified until someone reviews it."
            : "Documents your agency has asked for. Take a clear photo or choose a PDF, add the dates on it, and upload."}
        </p>
      </div>

      {canManage ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Request a document</h2>
          <RequestForm types={types.data ?? []} people={people.data ?? []} onDone={refresh} />
        </Card>
      ) : null}

      {canRead ? (
        <div className="flex gap-2" role="group" aria-label="Show">
          {(["attention", "all"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={filter === f ? "rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white" : "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"}>
              {f === "attention" ? "Needs action" : "All documents"}
            </button>
          ))}
        </div>
      ) : null}

      {docs.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {docs.isError ? <p role="alert" className="text-sm text-red-700">{(docs.error as Error).message}</p> : null}
      {!docs.isLoading && !docs.isError && shown.length === 0 ? (
        <p className="text-sm text-slate-500">{canRead ? (filter === "attention" ? "Nothing needs action." : "No documents requested yet.") : "Your agency has not requested any documents."}</p>
      ) : null}
      <ul className="space-y-3">
        {shown.map((d) => (
          <DocumentCard key={d.documentId} d={d} canManage={canManage} canUpload={canManage || canOwn} canReviewOwn={hasPermission("documents.review_own")} refresh={refresh} />
        ))}
      </ul>

      {canManage ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Document types</h2>
          <p className="text-xs text-slate-500">Set expiry only where the document has one. Reminder periods follow your agency's own requirements.</p>
          <TypesForm types={types.data ?? []} onDone={refresh} />
        </Card>
      ) : null}
    </div>
  );
}
