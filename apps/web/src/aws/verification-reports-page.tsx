// Visit verification reports (0124): exceptions, checked out without a signature, the time and signature register, corrections and audit, payroll and billing review, and the
// home label inventory. Staff only; every list is read from the server with the caller's own permissions, so a row that is on screen is a row the person may see. Rows never hold a
// signature image, a precise GPS position or a signing link, so neither the screen nor the CSV can show them.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { LabelInventory } from "./home-labels-panel";
import { useHomeLabelsAvailable } from "./home-labels-data";
import { exportRows } from "./report-export";
import { useOffices } from "./offices-data";

type Row = Record<string, unknown>;
interface ReportDef { key: string; title: string; hint: string; columns: Array<[string, string]>; statuses?: Array<[string, string]> }
const REPORTS: ReportDef[] = [
  { key: "visit_exceptions", title: "Visit exceptions", hint: "Missing or failed punches, overdue clock-outs, location issues, overlaps, disputed signatures and correction requests.",
    columns: [["Opened", "openedAt"], ["Age (hours)", "ageHours"], ["Kind", "kind"], ["Status", "status"], ["Caregiver", "caregiverName"], ["Client", "clientCode"], ["Scheduled", "scheduledStart"], ["Actual in", "actualTimeIn"], ["Actual out", "actualTimeOut"], ["Reviewer", "reviewerName"]],
    statuses: [["open", "Open"], ["in_review", "In review"], ["resolved", "Resolved"], ["dismissed", "Dismissed"]] },
  { key: "unsigned_checkouts", title: "Checked out without signature", hint: "Actual checkout is saved. These visits still need a valid signature. A late signature clears this list only; time and billing are not changed by it.",
    columns: [["Visit", "visitNumber"], ["Date", "serviceDate"], ["Caregiver", "caregiverName"], ["Client", "clientCode"], ["Checked out", "checkoutAt"], ["Pending (hours)", "pendingHours"], ["Reason", "reason"], ["Last request", "lastRequestAt"], ["Delivery", "lastDelivery"], ["Owner", "ownerName"]] },
  { key: "time_signature_register", title: "Visit time and signature register", hint: "Scheduled and actual times, punch method, expected location, location results and signature status.",
    columns: [["Visit", "visitNumber"], ["Date", "serviceDate"], ["Caregiver", "caregiverName"], ["Client", "clientCode"], ["Scheduled", "scheduledStart"], ["Actual in", "actualTimeIn"], ["Actual out", "actualTimeOut"], ["Punch in", "punchInMethod"], ["Punch out", "punchOutMethod"], ["Location in", "locationIn"], ["Location out", "locationOut"], ["Signature", "signatureStatus"], ["Signed", "signedAt"]],
    statuses: [["awaiting_signature", "Awaiting signature"], ["signed", "Signed"], ["administrator_review", "Needs review"]] },
  { key: "corrections_audit", title: "Corrections and audit", hint: "Original and revised values, who asked, who approved, why, whether a new signature is required, and label changes.",
    columns: [["When", "occurredAt"], ["Kind", "kind"], ["Subject", "subject"], ["Requested by", "requester"], ["Approved by", "approver"], ["Reason", "reason"], ["New signature", "needsResigning"], ["Location decision", "locationDecision"]] },
  { key: "billing_review", title: "Payroll and billing review", hint: "Recorded and reviewed minutes with signature and exception status shown separately. A billing hold appears only where your agency turned one on.",
    columns: [["Visit", "visitNumber"], ["Date", "serviceDate"], ["Caregiver", "caregiverName"], ["Client", "clientCode"], ["Recorded (min)", "recordedMinutes"], ["Reviewed (min)", "reviewedMinutes"], ["Billable (min)", "billableMinutes"], ["Open exceptions", "openExceptions"], ["Signature", "signatureStatus"], ["Billing hold", "billingHold"]] },
  { key: "label_inventory", title: "Home label inventory", hint: "Every sticker, its status and where it is installed. Client names and addresses are not shown here.", columns: [] },
];
const WORDS: Record<string, string> = { missing_punch: "Missing punch", failed_punch: "Punch not saved", overdue_clock_out: "Overdue clock-out", location_issue: "Location issue", overlap: "Overlap", disputed_signature: "Disputed signature", correction_request: "Correction request",
  within_range: "Within range", outside_range: "Outside range", unavailable: "Unavailable", low_accuracy: "Low accuracy", direct_required: "Direct confirmation needed", pending: "Pending", signed: "Signed", not_yet_due: "Not due yet",
  off_site_checkout: "Off-site checkout", signing_later: "Signing later", client_unavailable: "Client unavailable", declined: "Declined", times_corrected: "Times corrected", at_checkout: "At checkout",
  link_copied: "Link copied", request_created: "Link created", email_queued: "Email queued", delivery_failed: "Delivery failed", link_revoked: "Link revoked", time_correction: "Time correction", punch_correction: "Missed-punch correction", label_change: "Label change" };
function show(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (/(At|Start|End|Time|When|checkout|Checkout|Since|Opened)$/.test(key) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (typeof v === "string") return WORDS[v] ?? v.replace(/_/g, " ");
  return String(v);
}
const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base";
const fail = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "Could not save. Check your connection and try again.");

export function VerificationReportsPage() {
  const { hasPermission, activeOrganizationId } = useOrganization();
  const { available } = useHomeLabelsAvailable(hasPermission("visits.read") || hasPermission("organization.update"));
  const [tab, setTab] = useState(REPORTS[0]!.key);
  if (!hasPermission("visits.read")) return <p className="text-sm text-slate-600">You do not have access to this page.</p>;
  if (!available) return <p className="text-sm text-slate-600">Visit verification is not turned on for your agency yet.</p>;
  const def = REPORTS.find((r) => r.key === tab)!;
  return (
    <div className="space-y-3" data-org={activeOrganizationId ?? undefined}>
      <h1 className="text-2xl font-semibold">Visit verification</h1>
      <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-2">
        {REPORTS.map((r) => <button key={r.key} role="tab" type="button" aria-selected={r.key === tab} onClick={() => setTab(r.key)}
          className={`min-h-11 rounded-full border px-3 text-sm font-semibold ${r.key === tab ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white"}`}>{r.title}</button>)}
      </div>
      <p className="text-sm text-slate-600">{def.hint}</p>
      {tab === "label_inventory" ? <LabelInventory /> : <ReportTable def={def} key={def.key} />}
    </div>
  );
}

function ReportTable({ def }: { def: ReportDef }) {
  const api = useAwsApi();
  const cache = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [status, setStatus] = useState(def.key === "visit_exceptions" ? "open" : "");
  const [includeResolved, setIncludeResolved] = useState(false);
  const [office, setOffice] = useState("");
  const { offices, available: officesOn } = useOffices();
  const [note, setNote] = useState<string | null>(null);
  const query = { organizationId: activeOrganizationId, from: from || null, to: to || null, status: status || null, officeId: office || null, ...(def.key === "unsigned_checkouts" && includeResolved ? { includeResolved: "true" } : {}) };
  const data = useQuery({ queryKey: ["verification-report", def.key, query], retry: false, enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ rows: Row[] }>(`/v1/verification-reports/${def.key}`, query)).rows });
  const refresh = () => { void cache.invalidateQueries({ queryKey: ["verification-report", def.key] }); };
  async function csv() {
    setNote(null);
    try {
      const file = await api.get<{ csv: string; filename: string }>(`/v1/verification-reports/${def.key}`, { ...query, format: "csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" })); a.download = file.filename; a.click(); URL.revokeObjectURL(a.href);
    } catch (cause) { setNote(fail(cause)); }
  }
  const rows = data.data ?? [];
  return (
    <section aria-label={def.title} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></label>
        <label className="text-sm font-medium">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} /></label>
        {officesOn ? <label className="text-sm font-medium">Office<select value={office} onChange={(e) => setOffice(e.target.value)} className={input}><option value="">All offices</option>{offices.filter((o) => o.isActive).map((o) => <option key={o.officeId} value={o.officeId}>{o.name}</option>)}</select></label> : null}
        {def.statuses ? <label className="text-sm font-medium">Status<select value={status} onChange={(e) => setStatus(e.target.value)} className={input}><option value="">All</option>{def.statuses.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label> : null}
        {def.key === "unsigned_checkouts" ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} className="h-5 w-5" />Show cleared</label> : null}
        {hasPermission("reports.export") ? <>
          <Button type="button" onClick={() => void csv()}>Download CSV</Button>
          <Button type="button" onClick={() => exportRows("xlsx", def.key.replace(/_/g, "-"), def.title.slice(0, 31), def.columns.map(([h, k]) => [h, k, (v: unknown) => show(k, v)] as const), rows)}>Download Excel</Button>
          <Button type="button" onClick={() => window.print()}>Print</Button></> : null}
      </div>
      {note ? <p role="alert" className="text-sm text-red-700">{note}</p> : null}
      {data.isPending ? <p>Loading…</p> : null}
      {data.isError ? <p role="alert">This report could not be loaded.</p> : null}
      {data.isSuccess && rows.length === 0 ? <p>Nothing to show for these filters.</p> : null}
      {rows.length > 0 ? <div className="overflow-x-auto"><table className="min-w-full text-left text-sm" aria-label={def.title}>
        <thead><tr>{def.columns.map(([h]) => <th key={h} className="whitespace-nowrap border-b border-slate-300 px-2 py-2 font-semibold">{h}</th>)}<th className="border-b border-slate-300 px-2 py-2 font-semibold">Actions</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={String(r.exceptionId ?? r.visitId ?? i)} className="align-top odd:bg-slate-50">
          {def.columns.map(([h, k]) => <td key={h} className="px-2 py-2">{show(k, r[k])}</td>)}
          <td className="px-2 py-2"><RowActions report={def.key} row={r} onChanged={refresh} /></td>
        </tr>)}</tbody>
      </table></div> : null}
    </section>
  );
}

function RowActions({ report, row, onChanged }: { report: string; row: Row; onChanged: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const manage = hasPermission("visits.manage");
  const [open, setOpen] = useState<null | "resolve" | "link">(null);
  const [text, setText] = useState(""); const [name, setName] = useState(""); const [role, setRole] = useState("client"); const [check, setCheck] = useState(""); const [reason, setReason] = useState("poor_connectivity");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const org = activeOrganizationId;
  const run = useMutation({ mutationFn: async (task: () => Promise<void>) => task(), onSuccess: () => { onChanged(); }, onError: (c) => setNote(fail(c)) });
  if (!manage) return null;

  if (report === "visit_exceptions" && row.kind !== "overdue_clock_out" && row.kind !== "location_issue" && row.kind !== "correction_request" && (row.status === "open" || row.status === "in_review")) {
    return <div className="space-y-1">
      <div className="flex gap-1">
        {row.status === "open" ? <Button type="button" onClick={() => run.mutate(async () => { await api.post(`/v1/visit-exceptions/${row.exceptionId}/resolve`, { organizationId: org, action: "reviewing", note: "Review started" }); })}>Start review</Button> : null}
        <Button type="button" onClick={() => setOpen(open ? null : "resolve")}>Resolve</Button>
      </div>
      {open === "resolve" ? <div className="space-y-1"><label className="block">What was decided?<input value={text} onChange={(e) => setText(e.target.value)} className={input} /></label>
        <Button type="button" disabled={text.trim().length < 3 || run.isPending} onClick={() => run.mutate(async () => { await api.post(`/v1/visit-exceptions/${row.exceptionId}/resolve`, { organizationId: org, action: "resolved", note: text.trim() }); setOpen(null); setText(""); })}>Save decision</Button></div> : null}
      {note ? <p role="alert" className="text-red-700">{note}</p> : null}
    </div>;
  }
  // Audited missed-punch correction: a request, then a DIFFERENT reviewer decides. Approving a signed visit with a material time change reopens "Signature pending".
  if (report === "visit_exceptions" && row.kind === "correction_request" && (row.status === "open" || row.status === "in_review")) {
    const requestId = (row.detail as { request_id?: string } | null)?.request_id;
    if (!requestId) return null;
    const decide = (approve: boolean) => run.mutate(async () => { await api.post(`/v1/punch-corrections/${requestId}/decide`, { organizationId: org, approve, note: text.trim(), locationDecision: approve ? "accepted" : "rejected" }, { idempotencyKey: newIdempotencyKey() }); setText(""); });
    return <div className="space-y-1">
      <label className="block">Decision note<input value={text} onChange={(e) => setText(e.target.value)} className={input} /></label>
      <div className="flex gap-1"><Button type="button" disabled={run.isPending || text.trim().length < 3} onClick={() => decide(true)}>Approve</Button><Button type="button" disabled={run.isPending || text.trim().length < 3} onClick={() => decide(false)}>Reject</Button></div>
      <p className="text-xs text-slate-600">Someone other than the person who asked must decide.</p>
      {note ? <p role="alert" className="text-red-700">{note}</p> : null}
    </div>;
  }
  if (report === "visit_exceptions" && (row.kind === "overdue_clock_out" || row.kind === "location_issue") && row.visitId && (row.status === "open" || row.status === "in_review")) {
    const visit = String(row.visitId);
    return <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button type="button" onClick={() => setOpen(open ? null : "resolve")}>Resolve</Button>
        {row.kind === "overdue_clock_out" ? <Button type="button" onClick={() => setOpen(open === "link" ? null : "link")}>Request time correction</Button> : null}
      </div>
      {open === "resolve" ? <div className="space-y-1"><label className="block">What was decided?<input value={text} onChange={(e) => setText(e.target.value)} className={input} /></label>
        <Button type="button" disabled={text.trim().length < 3 || run.isPending} onClick={() => run.mutate(async () => { await api.post(`/v1/visit-exceptions/${row.exceptionId}/resolve`, { organizationId: org, action: "resolved", note: text.trim() }); setOpen(null); setText(""); })}>Save decision</Button></div> : null}
      {open === "link" ? <div className="space-y-1">
        <label className="block">Actual clock-out time<input type="datetime-local" value={name} onChange={(e) => setName(e.target.value)} className={input} /></label>
        <label className="block">Why was it missed?<select value={reason} onChange={(e) => setReason(e.target.value)} className={input}><option value="poor_connectivity">Poor connectivity</option><option value="dead_phone">Dead phone</option><option value="lost_tag">Lost or missing tag</option><option value="delayed_login">Delayed login</option><option value="other">Other</option></select></label>
        <label className="block">Details<input value={check} onChange={(e) => setCheck(e.target.value)} className={input} /></label>
        <Button type="button" disabled={run.isPending || !name || check.trim().length < 3} onClick={() => run.mutate(async () => {
          await api.post(`/v1/visits/${visit}/punch-corrections`, { reasonCode: reason, reasonNote: check.trim(), requestedTimeOut: new Date(name).toISOString() }, { idempotencyKey: newIdempotencyKey() }); setOpen(null);
        })}>Send request</Button></div> : null}
      {note ? <p role="alert" className="text-red-700">{note}</p> : null}
    </div>;
  }
  if (report === "unsigned_checkouts" && row.state === "pending") {
    const visit = String(row.visitId);
    return <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button type="button" onClick={() => run.mutate(async () => { await api.post(`/v1/visits/${visit}/signature-followup/owner`, { organizationId: org, assignToMe: true }); })}>Take ownership</Button>
        <Button type="button" onClick={() => setOpen(open ? null : "link")}>{row.lastRequestAt ? "Send again" : "Send signing link"}</Button>
      </div>
      {open === "link" ? <div className="space-y-1">
        <p>Use the person on file. A new link replaces the earlier one, expires in 7 days and works once. Give the code to them by phone.</p>
        <label className="block">Name<input value={name} onChange={(e) => setName(e.target.value)} className={input} /></label>
        <label className="block">Who<select value={role} onChange={(e) => setRole(e.target.value)} className={input}><option value="client">Client</option><option value="parent">Parent</option><option value="guardian">Guardian</option><option value="authorized_representative">Authorized representative</option></select></label>
        <label className="block">How you checked who they are<input value={check} onChange={(e) => setCheck(e.target.value)} className={input} /></label>
        <Button type="button" disabled={run.isPending || name.trim().length < 2 || check.trim().length < 5} onClick={() => run.mutate(async () => {
          const made = await api.post<{ requestId: string; token: string | null; code: string | null }>(`/v1/visits/${visit}/confirmation-requests`, { channel: "link", recipientName: name.trim(), recipientRole: role, identityCheck: check.trim(), expiresInDays: 7 }, { idempotencyKey: newIdempotencyKey() });
          await api.post(`/v1/visits/${visit}/signature-followup/delivery`, { organizationId: org, action: "request_created", requestId: made.requestId, channel: "copied", status: "created" });
          if (made.token) setLink(`${window.location.origin}/confirm-visit#${made.token}   code ${made.code}`);
        })}>Create link</Button>
        {link ? <div className="rounded bg-slate-100 p-2"><p className="break-all" data-testid="signing-link">{link}</p>
          <Button type="button" onClick={() => run.mutate(async () => { await navigator.clipboard?.writeText(link.split("   ")[0]!); await api.post(`/v1/visits/${visit}/signature-followup/delivery`, { organizationId: org, action: "link_copied", channel: "copied", status: "copied" }); setLink(null); setOpen(null); })}>Copy link</Button></div> : null}
      </div> : null}
      {note ? <p role="alert" className="text-red-700">{note}</p> : null}
    </div>;
  }
  return null;
}
