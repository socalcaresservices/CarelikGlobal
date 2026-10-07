// Missing-signature recovery on the visit page (0036). Staff ask the client or
// representative to confirm a visit later: a secure link (copied by staff and
// sent the way they normally contact the family) plus a one-time code that
// staff give only by phone after verifying who they are speaking to; or a paper
// form that staff upload. A person then reviews the response. Accepting it
// makes the visit eligible for the separate human billing approval; nothing is
// approved, submitted or billed here.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { formatDateOnly, formatDateTime, formatDuration } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useAwsApi } from "./aws-workspace";
import { prepareDocumentFile } from "./document-file";
import {
  RECOVERY_ROLE_LABEL,
  REQUEST_STATE_LABEL,
  confirmVisitLink,
  type ConfirmationRequestRow,
  type RecipientRole,
} from "./signature-recovery-format";

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const input = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm";

interface Props {
  visitId: string;
  organizationId: string;
  canManage: boolean;
  canRequest: boolean;
  recoveryState: "awaiting_response" | "response_to_review" | null;
  workedMinutes: number | null;
}

export function SignatureRecoveryCard({ visitId, organizationId, canManage, canRequest, recoveryState, workedMinutes }: Props) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["confirmation-requests", visitId],
    queryFn: async () => (await api.get<{ requests: ConfirmationRequestRow[] }>(`/v1/visits/${encodeURIComponent(visitId)}/confirmation-requests`, { organizationId })).requests,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ link: string; code: string; expiresAt: string } | null>(null);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["confirmation-requests", visitId] }),
      qc.invalidateQueries({ queryKey: ["visit-review", visitId] }),
      qc.invalidateQueries({ queryKey: ["aws-attention"] }),
      qc.invalidateQueries({ queryKey: ["aws-billing-review"] }),
    ]);
  }
  const done = async (text: string) => { setError(null); setNotice(text); await refresh(); };
  const failed = (cause: unknown, fallback: string) => { setNotice(null); setError(message(cause, fallback)); };

  const requests = list.data ?? [];
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold text-slate-950">Get the missing signature</h2>
      <p className="text-sm text-slate-700">
        Ask the client or their representative to confirm this visit now. While a request is open, the visit waits here
        instead of in Action needed. It is never closed for you, and nothing becomes billable until a person accepts
        the confirmation and billing is approved separately.
      </p>
      {recoveryState === "awaiting_response" ? <p className="rounded-lg bg-violet-50 p-2 text-sm text-violet-900">Waiting for the confirmation.</p> : null}
      {recoveryState === "response_to_review" ? <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">A response came in. Review it below.</p> : null}

      {created ? <CreatedLink created={created} onClose={() => setCreated(null)} /> : null}
      {canManage && canRequest && !created ? (
        <RequestForm
          onCreate={async (body, key) => {
            try {
              const r = await api.post<{ requestId: string; expiresAt: string; token: string | null; code: string | null; linkAlreadyShown?: boolean }>(
                `/v1/visits/${encodeURIComponent(visitId)}/confirmation-requests`, { organizationId, ...body }, { idempotencyKey: key });
              if (r.token && r.code) setCreated({ link: confirmVisitLink(window.location.origin, r.token), code: r.code, expiresAt: r.expiresAt });
              await done(r.linkAlreadyShown
                ? "This request was already made, and its link cannot be shown again. Revoke it and make a new one if you no longer have the link."
                : body.channel === "paper" ? "Paper form request recorded. Upload the signed form below when you have it." : "Secure link created.");
              return true;
            } catch (cause) {
              failed(cause, "The request was not created.");
              return false;
            }
          }}
        />
      ) : null}

      {list.isLoading ? <p className="text-sm text-slate-500">Loading requests…</p> : null}
      {list.isError ? <p role="alert" className="text-sm text-red-700">{message(list.error, "Requests could not be loaded.")}</p> : null}
      {requests.length > 0 ? (
        <ul className="space-y-3">
          {requests.map((r) => (
            <RequestItem
              key={r.requestId}
              r={r}
              organizationId={organizationId}
              canManage={canManage}
              workedMinutes={workedMinutes}
              onDone={done}
              onError={failed}
            />
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
    </Card>
  );
}

type RequestBody = { channel: "link" | "paper"; recipientName: string; recipientRole: RecipientRole; identityCheck: string | null; expiresInDays: number };

function RequestForm({ onCreate }: { onCreate: (body: RequestBody, key: string) => Promise<boolean> }) {
  const [channel, setChannel] = useState<"link" | "paper">("link");
  const [name, setName] = useState("");
  const [role, setRole] = useState<RecipientRole>("parent");
  const [check, setCheck] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (name.trim().length < 2) return setLocal("Enter the name of the person who will confirm the visit.");
    if (channel === "link" && check.trim().length < 5) return setLocal("Record how you will verify the person by phone before you give the code.");
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 30) return setLocal("The request must expire within 1 to 30 days.");
    setLocal(null);
    setBusy(true);
    const ok = await onCreate({ channel, recipientName: name.trim(), recipientRole: role, identityCheck: channel === "link" ? check.trim() : null, expiresInDays: n }, key.current);
    setBusy(false);
    if (ok) key.current = newIdempotencyKey();
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3 rounded-lg border border-slate-200 p-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">How</legend>
        <label className="flex gap-2 text-sm">
          <input type="radio" name="channel" checked={channel === "link"} onChange={() => { setChannel("link"); setDays("7"); }} className="mt-1" />
          <span><span className="font-medium">Secure link + code by phone.</span> <span className="block text-xs text-slate-600">You copy the link and send it yourself. The 6-digit code is given only by phone, after you confirm who you are speaking to.</span></span>
        </label>
        <label className="flex gap-2 text-sm">
          <input type="radio" name="channel" checked={channel === "paper"} onChange={() => { setChannel("paper"); setDays("14"); }} className="mt-1" />
          <span><span className="font-medium">Paper form.</span> <span className="block text-xs text-slate-600">The person signs a paper form; you upload a scan or photo of it.</span></span>
        </label>
      </fieldset>
      <label className="block text-sm font-medium text-slate-700">Person who will confirm
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={input} autoComplete="off" />
      </label>
      <label className="block text-sm font-medium text-slate-700">They are the
        <select value={role} onChange={(e) => setRole(e.target.value as RecipientRole)} className={input}>
          {Object.entries(RECOVERY_ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {channel === "link" ? (
        <label className="block text-sm font-medium text-slate-700">How you will verify them by phone
          <input value={check} onChange={(e) => setCheck(e.target.value)} maxLength={500} placeholder="For example: I will call the number on file" className={input} />
        </label>
      ) : null}
      <label className="block text-sm font-medium text-slate-700">Expires after (days)
        <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className={`${input} max-w-[8rem]`} />
      </label>
      {local ? <p role="alert" className="text-sm text-red-700">{local}</p> : null}
      <Button type="submit" disabled={busy}>{channel === "link" ? "Create secure link" : "Record paper form request"}</Button>
    </form>
  );
}

function CreatedLink({ created, onClose }: { created: { link: string; code: string; expiresAt: string }; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (what: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(what); } catch { setCopied(null); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
      <p className="font-semibold text-emerald-950">Shown only once. Copy them now.</p>
      <div>
        <p className="text-xs font-medium text-slate-600">1. Send this link (text or email, from your usual phone or email)</p>
        <p className="break-all rounded bg-white p-2 font-mono text-xs">{created.link}</p>
        <Button type="button" variant="secondary" onClick={() => void copy("link", created.link)}>{copied === "link" ? "Link copied" : "Copy link"}</Button>
      </div>
      <div>
        <p className="text-xs font-medium text-slate-600">2. Give this code only by phone, after confirming who you are speaking to. Never send it with the link.</p>
        <p className="font-mono text-2xl tracking-widest text-slate-950" aria-label="One-time code">{created.code}</p>
      </div>
      <p className="text-xs text-slate-600">Expires {formatDateTime(created.expiresAt)}. Five wrong codes lock the link.</p>
      <Button type="button" variant="secondary" onClick={onClose}>I have copied the link and noted the code</Button>
    </div>
  );
}

function RequestItem({ r, organizationId, canManage, workedMinutes, onDone, onError }: {
  r: ConfirmationRequestRow;
  organizationId: string;
  canManage: boolean;
  workedMinutes: number | null;
  onDone: (text: string) => Promise<void>;
  onError: (cause: unknown, fallback: string) => void;
}) {
  const api = useAwsApi();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ url: string; type: string } | null>(null);
  const key = useRef(newIdempotencyKey());

  async function post(path: string, body: Record<string, unknown>, ok: string, fallback: string) {
    setBusy(true);
    try {
      await api.post(path, { organizationId, ...body }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setReason("");
      await onDone(ok);
    } catch (cause) {
      onError(cause, fallback);
    } finally {
      setBusy(false);
    }
  }
  async function viewEvidence() {
    try {
      const f = await api.get<{ contentType: string; fileBase64: string }>(`/v1/late-confirmations/${encodeURIComponent(r.lateConfirmationId!)}/evidence`, { organizationId });
      setFile({ url: `data:${f.contentType};base64,${f.fileBase64}`, type: f.contentType });
    } catch (cause) {
      onError(cause, "The signature or form could not be loaded.");
    }
  }

  const reviewed = !!r.reviewOutcome;
  return (
    <li className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{REQUEST_STATE_LABEL[r.state] ?? r.state}</span>
        <span className="font-medium text-slate-900">{r.channel === "link" ? "Secure link" : "Paper form"} · {r.recipientName} ({RECOVERY_ROLE_LABEL[r.recipientRole] ?? r.recipientRole})</span>
      </div>
      <p className="text-xs text-slate-500">
        Requested {formatDateTime(r.createdAt)} by {r.createdByName ?? "staff"} · expires {formatDateTime(r.expiresAt)}
        {r.failedCodeAttempts > 0 ? ` · ${r.failedCodeAttempts} wrong code${r.failedCodeAttempts === 1 ? "" : "s"}` : ""}
      </p>
      {r.identityCheck ? <p className="text-xs text-slate-500">Phone verification: {r.identityCheck}</p> : null}
      {r.revokedAt ? <p className="text-xs text-slate-500">Closed {formatDateTime(r.revokedAt)}: {r.revokeReason}</p> : null}

      {r.lateConfirmationId ? (
        <div className="space-y-1 rounded bg-slate-50 p-2">
          <p className="font-medium text-slate-900">
            {r.outcome === "confirmed"
              ? `Confirmed by ${r.signerName} (${RECOVERY_ROLE_LABEL[r.signerRole ?? ""] ?? r.signerRole}) — ${r.method === "draw" ? "drawn signature" : r.method === "typed" ? "typed name" : "paper form"}`
              : `Reported a problem: ${r.signerName}`}
          </p>
          {r.disputeReason ? <p className="text-slate-800">“{r.disputeReason}”</p> : null}
          <p className="text-xs text-slate-500">
            Received {r.receivedAt ? formatDateTime(r.receivedAt) : ""}{r.signedOn ? ` · date on form ${formatDateOnly(r.signedOn)}` : ""}{r.recordedByName ? ` · uploaded by ${r.recordedByName}` : ""}
          </p>
          {r.hasEvidence ? <Button type="button" variant="secondary" onClick={() => void viewEvidence()}>{r.method === "paper" ? "View form" : "View signature"}</Button> : null}
          {file ? (file.type === "application/pdf"
            ? <a href={file.url} download="paper-form.pdf" className="block text-sm underline">Download the form (PDF)</a>
            : <img src={file.url} alt={r.method === "paper" ? "Scanned paper form" : "Signature"} className="max-h-64 max-w-full rounded border border-slate-200 bg-white" />) : null}
          {reviewed ? (
            <p className="text-sm">
              <span className="font-medium">{r.reviewOutcome === "accepted" ? `Accepted — ${formatDuration(r.acceptedMinutes)} eligible for billing approval${r.cappedByAuthorization ? " (capped by the authorization)" : ""}` : "Rejected"}</span>
              <span className="block text-xs text-slate-500">“{r.reviewReason}” · {r.reviewedByName} · {r.reviewedAt ? formatDateTime(r.reviewedAt) : ""}</span>
            </p>
          ) : canManage ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-600">
                {r.outcome === "confirmed"
                  ? `Accepting makes up to ${formatDuration(workedMinutes)} (less if the authorization has less left) eligible for billing approval. It does not approve or submit anything.`
                  : "A reported problem cannot be accepted. Record that you reviewed it, then correct the visit or close it."}
              </p>
              <label className="block text-sm font-medium text-slate-700">Reason (required)
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={input} />
              </label>
              <div className="flex flex-wrap gap-2">
                {r.outcome === "confirmed" ? (
                  <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void post(`/v1/late-confirmations/${encodeURIComponent(r.lateConfirmationId!)}/review`, { outcome: "accepted", reason: reason.trim() }, "Confirmation accepted. The visit can now be approved for billing in Billing review.", "The review was not saved.")}>Accept confirmation</Button>
                ) : null}
                <Button type="button" variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => void post(`/v1/late-confirmations/${encodeURIComponent(r.lateConfirmationId!)}/review`, { outcome: "rejected", reason: reason.trim() }, r.outcome === "confirmed" ? "Confirmation rejected. The visit needs review again." : "Reviewed. The visit needs review again.", "The review was not saved.")}>
                  {r.outcome === "confirmed" ? "Reject" : "Record as reviewed"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {canManage && r.state === "open" ? (
        <div className="space-y-2">
          <PaperUpload requestId={r.requestId} organizationId={organizationId} defaultName={r.recipientName} defaultRole={r.recipientRole} onDone={onDone} onError={onError} />
          <details>
            <summary className="cursor-pointer text-xs text-slate-600 underline">Revoke this request</summary>
            <label className="mt-2 block text-sm font-medium text-slate-700">Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={input} />
            </label>
            <Button type="button" variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => void post(`/v1/visit-confirmation-requests/${encodeURIComponent(r.requestId)}/revoke`, { reason: reason.trim() }, "Request revoked. The link no longer works.", "The request was not revoked.")}>Revoke</Button>
          </details>
        </div>
      ) : null}
    </li>
  );
}

function PaperUpload({ requestId, organizationId, defaultName, defaultRole, onDone, onError }: {
  requestId: string;
  organizationId: string;
  defaultName: string;
  defaultRole: RecipientRole;
  onDone: (text: string) => Promise<void>;
  onError: (cause: unknown, fallback: string) => void;
}) {
  const api = useAwsApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [role, setRole] = useState<RecipientRole>(defaultRole);
  const [signedOn, setSignedOn] = useState("");
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  if (!open) return <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Upload a signed paper form</Button>;
  async function submit() {
    if (!picked) return onError(null, "Choose the scanned form (PDF, JPEG or PNG).");
    if (!signedOn) return onError(null, "Enter the date written on the form.");
    setBusy(true);
    try {
      const f = await prepareDocumentFile(picked);
      await api.post(`/v1/visit-confirmation-requests/${encodeURIComponent(requestId)}/paper`, {
        organizationId, signerName: name.trim(), signerRole: role, signedOn, fileBase64: f.base64, contentType: f.contentType,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setOpen(false);
      await onDone("Paper form recorded. Review it below.");
    } catch (cause) {
      onError(cause, "The form was not saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-2 rounded-lg border border-slate-200 p-3">
      <label className="block text-sm font-medium text-slate-700">Signed by
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={input} />
      </label>
      <label className="block text-sm font-medium text-slate-700">They are the
        <select value={role} onChange={(e) => setRole(e.target.value as RecipientRole)} className={input}>
          {Object.entries(RECOVERY_ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">Date written on the form
        <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} className={input} />
      </label>
      <label className="block text-sm font-medium text-slate-700">Scan or photo (PDF, JPEG or PNG, up to 4 MB)
        <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
      </label>
      <Button type="submit" disabled={busy}>Save paper form</Button>
    </form>
  );
}
