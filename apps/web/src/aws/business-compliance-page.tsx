import { useRef } from "react";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { prepareDocumentFile } from "./document-file";
import { useAgencyClock } from "./agency-clock";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { PageHeader } from "./ui/page-header";

type DocumentStatus = "Overdue" | "Due soon" | "Needs review" | "Current";
interface BusinessDocument {
  id: string;
  name: string;
  responsiblePerson: string | null;
  dueOn: string | null;
  notes: string | null;
  status: DocumentStatus;
  updatedAt: string;
  files?: { id: string; createdAt: string }[];
  history: { action: string; at: string; actor: string; dueOn: string | null }[];
}
const statuses: DocumentStatus[] = ["Overdue", "Due soon", "Needs review", "Current"];
const empty = { name: "", responsiblePerson: "", dueOn: "", notes: "" };
const inputClass = "mt-1 block w-full rounded border border-og-line bg-og-card p-2";
const styles: Record<DocumentStatus, string> = {
  Overdue: "bg-red-100 text-red-900",
  "Due soon": "bg-amber-100 text-amber-900",
  "Needs review": "bg-blue-100 text-blue-900",
  Current: "bg-emerald-100 text-emerald-900",
};

function renewalStatus(record: BusinessDocument, today: string): Exclude<DocumentStatus, "Needs review"> | "No date set" {
  const due = record.dueOn?.slice(0, 10);
  if (!due) return "No date set";
  if (due < today) return "Overdue";
  const days = (Date.parse(due) - Date.parse(today)) / 86_400_000;
  return days <= 30 ? "Due soon" : "Current";
}

function needsReview(record: BusinessDocument) {
  return record.history?.length ? !record.history[0]!.action.endsWith(".reviewed") : record.status === "Needs review";
}

function matchesStatus(record: BusinessDocument, status: string | null, today: string) {
  if (status === "Missing attachment") return !record.files?.length;
  return !status || (status === "Needs review" ? needsReview(record) : renewalStatus(record, today) === status);
}
function useBusinessDocuments() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("accounts.manage");
  const key = ["business-documents", activeOrganizationId];
  const query = useQuery({
    queryKey: key,
    enabled: allowed && !!activeOrganizationId,
    queryFn: async () => (await api.get<{ documents: BusinessDocument[] }>("/v1/business-documents", {
      organizationId: activeOrganizationId,
    })).documents,
  });
  return { api, activeOrganizationId, allowed, key, query };
}

export function BusinessComplianceTile() {
  const { allowed, query } = useBusinessDocuments();
  const { today } = useAgencyClock();
  if (!allowed) return null;
  const count = (status: DocumentStatus) => query.data?.filter((row) => matchesStatus(row, status, today)).length ?? 0;
  return <section aria-label="Business compliance summary" className="flex flex-wrap items-center gap-3 rounded-og border border-og-line bg-og-card p-3 text-sm">
    <Link className="font-bold text-og-link underline" to="/business-compliance">Business Compliance</Link>
    {query.isLoading ? <span>Loading…</span> : null}
    {query.isError ? <span>Tracker status unavailable.</span> : null}
    {query.data ? <>
      <Link className="underline" to="/business-compliance?status=Overdue">{count("Overdue")} overdue</Link>
      <Link className="underline" to="/business-compliance?status=Due%20soon">{count("Due soon")} due soon</Link>
      <Link className="underline" to="/business-compliance?status=Needs%20review">{count("Needs review")} need review</Link>
    </> : null}
  </section>;
}

function BusinessAttachments({ record }: { record: BusinessDocument }) {
  const { api, activeOrganizationId, key } = useBusinessDocuments();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const uploadKey = useRef(newIdempotencyKey());
  const fileInput = useRef<HTMLInputElement>(null);
  async function upload() {
    if (!file || busy) return;
    setBusy(true); setError(""); setDone("");
    try {
      const prepared = await prepareDocumentFile(file);
      await api.post("/v1/business-documents", { organizationId: activeOrganizationId, id: record.id,
        operation: "upload", fileBase64: prepared.base64, contentType: prepared.contentType }, { idempotencyKey: uploadKey.current });
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      uploadKey.current = newIdempotencyKey();
      setDone("Attachment saved. Review the new version.");
      await qc.invalidateQueries({ queryKey: key });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save attachment."); }
    finally { setBusy(false); }
  }
  async function download(id: string) {
    setBusy(true); setError("");
    try {
      const result = await api.get<{ contentType: string; fileBase64: string }>("/v1/business-documents", {
        organizationId: activeOrganizationId, fileId: id,
      });
      const bytes = Uint8Array.from(atob(result.fileBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `business-document.${result.contentType === "application/pdf" ? "pdf" : result.contentType === "image/png" ? "png" : "jpg"}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not download attachment."); }
    finally { setBusy(false); }
  }
  return <details className="sm:col-span-4">
    <summary className="cursor-pointer font-medium">Attachments ({record.files?.length ?? 0})</summary>
    <div className="mt-2 space-y-2">
      {(record.files ?? []).map((version, i) => <button key={version.id} type="button" disabled={busy}
        className="block text-og-link underline" onClick={() => void download(version.id)}>
        Download {i === 0 ? "current file" : "earlier version"} · {new Date(version.createdAt).toLocaleDateString()}
      </button>)}
      <label className="block">Add PDF or photo<input type="file" accept="application/pdf,image/jpeg,image/png"
        className="mt-1 block max-w-full" ref={fileInput} disabled={busy} onChange={(event) => {
          uploadKey.current = newIdempotencyKey(); setFile(event.target.files?.[0] ?? null); setError(""); setDone("");
        }} /></label>
      <Button type="button" variant="secondary" disabled={busy || !file} onClick={() => void upload()}>Save attachment</Button>
      {error ? <p role="alert">{error}</p> : null}
      {done ? <p role="status">{done}</p> : null}
    </div>
  </details>;
}
export function BusinessCompliancePage() {
  const { api, activeOrganizationId, allowed, key, query } = useBusinessDocuments();
  const qc = useQueryClient();
  const { today } = useAgencyClock();
  const [params, setParams] = useSearchParams();
  const status = params.get("status");
  const [editing, setEditing] = useState<BusinessDocument | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: ({ record, review }: { record?: BusinessDocument; review?: boolean }) =>
      api.post("/v1/business-documents", {
        organizationId: activeOrganizationId, ...(review && record ? record : form),
        id: record?.id, updatedAt: record?.updatedAt, review: review === true,
      }),
    onSuccess: async (_result, vars) => {
      setNotice(vars.review ? "Review recorded." : "Document details saved.");
      setEditing(null);
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  if (!allowed) return <p className="text-sm text-og-sub">You do not have access to business compliance.</p>;
  const start = (record: BusinessDocument | "new") => {
    save.reset(); setNotice(""); setEditing(record);
    setForm(record === "new" ? empty : {
      name: record.name, responsiblePerson: record.responsiblePerson ?? "",
      dueOn: record.dueOn?.slice(0, 10) ?? "", notes: record.notes ?? "",
    });
  };
  const docs = query.data ?? [];
  const visible = docs.filter((row) => !status || matchesStatus(row, status, today));
  return <div className="max-w-5xl space-y-4">
    <PageHeader title="Business Compliance" lead="Track agency documents, renewals, and reviews."
      action={<Button onClick={() => start("new")} disabled={save.isPending}>Add document record</Button>} />
    <div className="flex flex-wrap gap-2" aria-label="Filter business documents">
      {[null, ...statuses, "Missing attachment"].map((value) => <button type="button" key={value ?? "all"} aria-pressed={status === value}
        onClick={() => setParams(value ? { status: value } : {})}
        className={`rounded-og border border-og-line px-3 py-2 text-sm font-semibold ${status === value ? "bg-teal-800 text-white" : "bg-og-card text-og-ink"}`}>
        {value ?? "All"} ({value ? docs.filter((row) => matchesStatus(row, value, today)).length : docs.length})
      </button>)}
    </div>
    {notice ? <p role="status">{notice}</p> : null}
    {query.isLoading ? <p role="status">Loading documents…</p> : null}
    {query.isError ? <p role="alert">Business documents could not be loaded. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : null}
    {save.isError ? <p role="alert">{save.error.message}</p> : null}
    {editing ? <form className="grid gap-3 rounded-og border border-og-line bg-og-card p-4 sm:grid-cols-2"
      onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(editing === "new" ? {} : { record: editing }); }}>
      <h2 className="text-lg font-bold sm:col-span-2">{editing === "new" ? "New document record" : "Edit document record"}</h2>
      <label>Document name<input className={inputClass} required maxLength={120} value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Responsible person<input className={inputClass} maxLength={120} value={form.responsiblePerson}
        onChange={(e) => setForm({ ...form, responsiblePerson: e.target.value })} /></label>
      <label>Renewal or review date<input className={inputClass} type="date" value={form.dueOn}
        onChange={(e) => setForm({ ...form, dueOn: e.target.value })} /></label>
      <label className="sm:col-span-2">Notes<textarea className={inputClass} maxLength={2000} value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save record"}</Button>
        <Button type="button" variant="secondary" disabled={save.isPending} onClick={() => { setEditing(null); save.reset(); }}>Cancel</Button></div>
    </form> : null}
    {query.data && visible.length === 0 ? <p className="text-sm text-og-sub">{status ? "No documents match this status." : "No records yet. Add a document to start tracking it."}</p> : null}
    {visible.length ? <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card" aria-label="Business documents">
      {visible.map((record) => <li key={record.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[2fr_1fr_1fr_1fr] sm:items-start">
        <div><h2 className="font-bold">{record.name}</h2><p className="text-og-sub">{record.responsiblePerson || "Unassigned"}</p>
          {record.notes ? <p className="mt-1 whitespace-pre-wrap break-words">{record.notes}</p> : null}</div>
        <div className="space-y-1">
          <p><span className="font-medium">Renewal:</span> {renewalStatus(record, today)}</p>
          <p><span className="font-medium">Review:</span> {needsReview(record) ? <span className={styles["Needs review"]}>Needs review</span> : "Reviewed"}</p>
        </div>
        <p>{record.dueOn ? `Due ${record.dueOn.slice(0, 10)}` : "No due date"}{renewalStatus(record, today) === "Due soon" && record.dueOn ? <span className="block font-semibold">Renewal in {Math.round((Date.parse(record.dueOn.slice(0, 10)) - Date.parse(today)) / 86_400_000)} days</span> : null}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={() => start(record)}>Edit</Button>
          {needsReview(record) ? <Button variant="secondary" disabled={save.isPending || !!editing}
            onClick={() => { setNotice(""); save.mutate({ record, review: true }); }}>Mark reviewed</Button> : null}
        </div>
        <BusinessAttachments record={record} />
        {record.history?.length ? <details className="sm:col-span-4">
          <summary className="cursor-pointer font-medium">Recent history</summary>
          <ul className="mt-1 space-y-1 text-og-sub">{record.history.map((event, i) =>
            <li key={`${event.at}-${i}`}>{event.action.endsWith(".reviewed") ? "Reviewed" : event.action.endsWith(".attachment_added") ? "Attachment added" : "Saved"} by {event.actor} · {new Date(event.at).toLocaleString()}{event.dueOn ? ` · Due ${event.dueOn}` : ""}</li>)}</ul>
        </details> : null}
      </li>)}
    </ul> : null}
  </div>;
}
