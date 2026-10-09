// Caregiver readiness screens (0039-0041): services, experience, location, availability review, settings.
// Every rule lives on the server; these cards collect input, show the server's answer and keep typed values on error.
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import type { AvailUnavailable, AvailWindow } from "./availability-format";
import { AvailabilitySummary } from "./availability-ui";
import { DOCUMENT_STATE_LABEL } from "./readiness-format";

const input = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** One in-flight action with its error. The idempotency key changes only after success, so a retry cannot double-apply. */
function useSend() {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function run(action: (idempotencyKey: string) => Promise<unknown>, fallback: string, onDone?: () => void): Promise<boolean> {
    setState({ busy: true, error: null });
    try {
      await action(key.current);
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null });
      onDone?.();
      return true;
    } catch (cause) {
      setState({ busy: false, error: errorText(cause, fallback) });
      return false;
    }
  }
  return { ...state, run, clear: () => setState({ busy: false, error: null }) };
}

function Failure({ message }: { message: string | null }) {
  return message ? <p role="alert" className="mt-2 text-sm text-red-700">{message}</p> : null;
}
function Loading({ q, what }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown }; what: string }) {
  if (q.isLoading) return <p className="text-sm text-slate-500" role="status">Loading {what}…</p>;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">{errorText(q.error, `${what} could not be loaded.`)} <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button></p>;
  return null;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-sm font-medium text-slate-700">{label}{children}</label>;
}

// ---------------------------------------------------------------- caregiver (own)

type Approval = { approvalId?: string; serviceId: string; serviceCode: string; serviceName: string; effectiveFrom: string; effectiveTo: string | null; state: string };
const APPROVAL_STATE: Record<string, string> = { current: "Approved", future: "Starts later", expired: "Ended", revoked: "Revoked" };

export function MyServicesCard() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["my-service-approvals", activeOrganizationId],
    queryFn: async () => (await api.get<{ approvals: Approval[] }>("/v1/service-approvals/me", { organizationId: activeOrganizationId })).approvals,
    enabled: !!activeOrganizationId,
  });
  return (
    <Card>
      <h2 className="font-semibold text-slate-950">Services</h2>
      <p className="mt-1 text-sm text-slate-600">Services your agency has approved you to provide. Ask your agency to change this.</p>
      <Loading q={q} what="services" />
      {q.data && q.data.length === 0 ? <p className="mt-2 text-sm text-slate-500">No services approved yet.</p> : null}
      <ul className="mt-2 space-y-1">{(q.data ?? []).map((a) => <li key={`${a.serviceId}-${a.effectiveFrom}`} className="flex flex-wrap justify-between gap-2 text-sm"><span>{a.serviceName}</span><span className="text-slate-600">{APPROVAL_STATE[a.state] ?? a.state} · from {a.effectiveFrom}{a.effectiveTo ? ` to ${a.effectiveTo}` : ""}</span></li>)}</ul>
    </Card>
  );
}

type ExperienceRow = { experienceId: string; tagId: string; tagName: string; context: string | null; source: string; status: string; reviewedByName: string | null; reviewNote: string | null; profileReviewedAt: string | null };
type Tag = { tagId: string; name: string; isActive: boolean };
const EXPERIENCE_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "Awaiting review", className: "bg-sky-100 text-sky-900" },
  verified: { label: "Verified", className: "bg-teal-50 text-teal-900 ring-1 ring-teal-200" },
  declined: { label: "Not verified", className: "bg-amber-100 text-amber-900" },
  removed: { label: "Removed", className: "bg-slate-200 text-slate-800" },
};

function useTags() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["experience-tags", activeOrganizationId],
    queryFn: async () => (await api.get<{ tags: Tag[] }>("/v1/experience-tags", { organizationId: activeOrganizationId })).tags,
    enabled: !!activeOrganizationId,
  });
}

export function MyExperienceCard() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const tags = useTags();
  const mine = useQuery({
    queryKey: ["my-experience", activeOrganizationId],
    queryFn: async () => (await api.get<{ experience: ExperienceRow[] }>("/v1/experience/me", { organizationId: activeOrganizationId })).experience,
    enabled: !!activeOrganizationId,
  });
  const [tagId, setTagId] = useState("");
  const [context, setContext] = useState("");
  const send = useSend();
  const held = new Set((mine.data ?? []).filter((e) => e.status === "pending" || e.status === "verified").map((e) => e.tagId));
  const options = (tags.data ?? []).filter((t) => t.isActive && !held.has(t.tagId));
  return (
    <Card>
      <h2 className="font-semibold text-slate-950">Experience</h2>
      <p className="mt-1 text-sm text-slate-600">Tell your agency what you have experience with. It counts toward matching only after an administrator verifies it.</p>
      <Loading q={mine} what="experience" />
      <ul className="mt-2 space-y-1">{(mine.data ?? []).filter((e) => e.status !== "removed").map((e) => {
        const s = EXPERIENCE_STATUS[e.status] ?? { label: e.status, className: "bg-slate-100 text-slate-800" };
        return <li key={e.experienceId} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{e.tagName}{e.context ? <span className="text-slate-500"> — {e.context}</span> : null}</span><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.className}`}>{s.label}</span></li>;
      })}</ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="Experience"><select value={tagId} onChange={(e) => setTagId(e.target.value)} className={input}><option value="">Choose…</option>{options.map((t) => <option key={t.tagId} value={t.tagId}>{t.name}</option>)}</select></Field>
        <Field label="Detail (optional)"><input value={context} maxLength={300} onChange={(e) => setContext(e.target.value)} className={input} /></Field>
      </div>
      <Failure message={send.error} />
      <Button className="mt-3" disabled={!tagId} loading={send.busy}
        onClick={() => void send.run(() => api.post("/v1/experience/me", { organizationId: activeOrganizationId, tagId, context: context.trim() || null }), "Your experience was not saved.", () => { setTagId(""); setContext(""); void qc.invalidateQueries({ queryKey: ["my-experience"] }); })}>Send for review</Button>
    </Card>
  );
}

// ---------------------------------------------------------------- administrator: one caregiver

export function CaregiverReadinessCards({ caregiverRecordId }: { caregiverRecordId: string }) {
  return (
    <>
      <AdminAvailabilityCard caregiverRecordId={caregiverRecordId} />
      <AdminServicesCard caregiverRecordId={caregiverRecordId} />
      <AdminDocumentsCard caregiverRecordId={caregiverRecordId} />
      <AdminExperienceCard caregiverRecordId={caregiverRecordId} />
      <AdminLocationCard caregiverRecordId={caregiverRecordId} />
    </>
  );
}

function AdminAvailabilityCard({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["cg-availability", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ availability: { timezone: string; version: number; provided: boolean; windows: AvailWindow[]; unavailable: AvailUnavailable[]; updatedAt: string | null; updatedBy: string | null; updateSource: string | null } }>(`/v1/caregivers/${caregiverRecordId}/availability`, { organizationId: activeOrganizationId })).availability,
    enabled: !!activeOrganizationId,
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Availability</h2>
      <Loading q={q} what="availability" />
      {q.data ? <>
        <div className="mt-2"><AvailabilitySummary windows={q.data.windows} unavailable={q.data.unavailable} empty="Not provided. Matching shows this caregiver's availability as unknown, not as unavailable." /></div>
        <p className="mt-2 text-xs text-slate-500">Agency time zone {q.data.timezone}.{q.data.updatedAt ? ` Last approved ${formatDateTime(q.data.updatedAt)}${q.data.updatedBy ? ` by ${q.data.updatedBy}` : ""}.` : ""} Changes arrive as requests; review them under Care Team.</p>
      </> : null}
    </Card>
  );
}

function AdminServicesCard({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const approvals = useQuery({
    queryKey: ["cg-service-approvals", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ approvals: Array<Approval & { approvalId: string; reason: string; approvedByName: string | null; revokedAt: string | null; revokedReason: string | null }> }>(`/v1/caregivers/${caregiverRecordId}/service-approvals`, { organizationId: activeOrganizationId })).approvals,
    enabled: !!activeOrganizationId,
  });
  const services = useQuery({
    queryKey: ["services-list", activeOrganizationId],
    queryFn: async () => (await api.get<{ services: Array<{ serviceId: string; code: string; name: string; isActive: boolean }> }>("/v1/services", { organizationId: activeOrganizationId })).services,
    enabled: !!activeOrganizationId,
  });
  const [serviceId, setServiceId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const add = useSend();
  const revoke = useSend();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cg-service-approvals"] });
  const valid = serviceId && from && reason.trim() && (!to || to >= from);
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Services</h2>
      <p className="mt-1 text-sm text-slate-600">An explicit approval is needed for each service. Nothing is approved automatically.</p>
      <Loading q={approvals} what="approvals" />
      {approvals.data && approvals.data.length === 0 ? <p className="mt-2 text-sm text-slate-500">No approvals yet.</p> : null}
      <ul className="mt-2 space-y-2">{(approvals.data ?? []).map((a) => (
        <li key={a.approvalId} className="rounded-lg border border-slate-100 p-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{a.serviceName}</span><span className="text-slate-600">{APPROVAL_STATE[a.state] ?? a.state} · from {a.effectiveFrom}{a.effectiveTo ? ` to ${a.effectiveTo}` : ""}</span></div>
          <p className="text-xs text-slate-500">{a.reason}{a.approvedByName ? ` — ${a.approvedByName}` : ""}{a.revokedAt ? ` · revoked ${formatDateTime(a.revokedAt)}: ${a.revokedReason ?? ""}` : ""}</p>
          {!a.revokedAt && a.state !== "expired" ? (revoking === a.approvalId ? (
            <div className="mt-2 space-y-2">
              <Field label="Reason for revoking (required)"><input value={revokeReason} maxLength={500} onChange={(e) => setRevokeReason(e.target.value)} className={input} /></Field>
              <Failure message={revoke.error} />
              <div className="flex gap-2"><Button size="sm" loading={revoke.busy} disabled={!revokeReason.trim()} onClick={() => void revoke.run((k) => api.post(`/v1/service-approvals/${a.approvalId}/revoke`, { reason: revokeReason.trim() }, { idempotencyKey: k }), "The approval was not revoked.", () => { setRevoking(null); setRevokeReason(""); refresh(); })}>Revoke</Button><Button size="sm" variant="secondary" onClick={() => { setRevoking(null); revoke.clear(); }}>Cancel</Button></div>
            </div>
          ) : <Button size="sm" variant="secondary" className="mt-2 min-h-[40px]" onClick={() => { setRevoking(a.approvalId); setRevokeReason(""); revoke.clear(); }}>Revoke</Button>) : null}
        </li>
      ))}</ul>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">Approve a service</h3>
      <div className="mt-1 grid gap-2 sm:grid-cols-3">
        <Field label="Service"><select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={input}><option value="">Choose…</option>{(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name}</option>)}</select></Field>
        <Field label="Starts"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></Field>
        <Field label="Ends (optional)"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} /></Field>
      </div>
      {to && from && to < from ? <p role="alert" className="mt-1 text-sm text-red-700">The end date is before the start date.</p> : null}
      <div className="mt-2"><Field label="Reason (required)"><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} /></Field></div>
      <Failure message={add.error} />
      <Button className="mt-3" disabled={!valid} loading={add.busy}
        onClick={() => void add.run((k) => api.post(`/v1/caregivers/${caregiverRecordId}/service-approvals`, { organizationId: activeOrganizationId, serviceId, effectiveFrom: from, effectiveTo: to || null, reason: reason.trim() }, { idempotencyKey: k }), "The approval was not saved.", () => { setServiceId(""); setFrom(""); setTo(""); setReason(""); refresh(); })}>Approve service</Button>
    </Card>
  );
}

type Compliance = { caregiverRecordId: string; documentTypeId: string; documentTypeName: string; state: string; validThrough: string | null; reviewDueOn: string | null; daysLeft: number | null; pendingReplacement: boolean };
const DOC_BADGE: Record<string, string> = { ok: "bg-teal-50 text-teal-900 ring-1 ring-teal-200", missing: "bg-red-100 text-red-800", expired: "bg-red-100 text-red-800", revoked: "bg-red-100 text-red-800", rejected: "bg-amber-100 text-amber-900" };

function useCompliance() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["document-compliance", activeOrganizationId],
    queryFn: async () => (await api.get<{ compliance: Compliance[] }>("/v1/documents/compliance", { organizationId: activeOrganizationId })).compliance,
    enabled: !!activeOrganizationId,
  });
}

function AdminDocumentsCard({ caregiverRecordId }: { caregiverRecordId: string }) {
  const q = useCompliance();
  const rows = (q.data ?? []).filter((r) => r.caregiverRecordId === caregiverRecordId);
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Documents</h2>
      <p className="mt-1 text-sm text-slate-600">Required documents only. Verify and revoke on the <Link to="/documents" className="underline">Documents</Link> page, where you can open the file.</p>
      <Loading q={q} what="documents" />
      {q.data && rows.length === 0 ? <p className="mt-2 text-sm text-slate-500">No documents are marked required for this agency.</p> : null}
      <ul className="mt-2 space-y-1">{rows.map((r) => (
        <li key={r.documentTypeId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{r.documentTypeName}</span>
          <span className="flex items-center gap-2"><span className="text-xs text-slate-600">{r.validThrough ? `through ${r.validThrough}` : ""}{r.pendingReplacement ? " · replacement waiting" : ""}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${DOC_BADGE[r.state] ?? "bg-sky-100 text-sky-900"}`}>{DOCUMENT_STATE_LABEL[r.state] ?? r.state}</span></span>
        </li>
      ))}</ul>
    </Card>
  );
}

function AdminExperienceCard({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["cg-experience", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ experience: ExperienceRow[] }>(`/v1/caregivers/${caregiverRecordId}/experience`, { organizationId: activeOrganizationId })).experience,
    enabled: !!activeOrganizationId,
  });
  const tags = useTags();
  const [note, setNote] = useState("");
  const [tagId, setTagId] = useState("");
  const review = useSend();
  const add = useSend();
  const mark = useSend();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cg-experience"] });
  const reviewedAt = q.data?.[0]?.profileReviewedAt ?? null;
  const act = (id: string, decision: "verify" | "decline" | "remove") =>
    void review.run(() => api.post(`/v1/experience/${id}/review`, { decision, note: note.trim() || null }), "The review was not saved.", () => { setNote(""); refresh(); });
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Experience</h2>
      <p className="mt-1 text-sm text-slate-600">Only verified experience counts. Verifying records your name and the time; it is your confirmation, not an outside credential.</p>
      <Loading q={q} what="experience" />
      <ul className="mt-2 space-y-2">{(q.data ?? []).filter((e) => e.status !== "removed").map((e) => {
        const s = EXPERIENCE_STATUS[e.status] ?? { label: e.status, className: "bg-slate-100 text-slate-800" };
        return <li key={e.experienceId} className="rounded-lg border border-slate-100 p-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span>{e.tagName}{e.context ? <span className="text-slate-500"> — {e.context}</span> : null}<span className="ml-2 text-xs text-slate-500">{e.source === "caregiver" ? "Submitted by caregiver" : "Added by administrator"}</span></span><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.className}`}>{s.label}</span></div>
          <div className="mt-2 flex flex-wrap gap-2">
            {e.status === "pending" ? <><Button size="sm" className="min-h-[40px]" disabled={review.busy} onClick={() => act(e.experienceId, "verify")}>Verify</Button><Button size="sm" variant="secondary" className="min-h-[40px]" disabled={review.busy} onClick={() => act(e.experienceId, "decline")}>Do not verify</Button></> : null}
            {e.status === "verified" ? <Button size="sm" variant="secondary" className="min-h-[40px]" disabled={review.busy} onClick={() => act(e.experienceId, "remove")}>Remove</Button> : null}
          </div>
        </li>;
      })}</ul>
      {(q.data ?? []).some((e) => e.status === "pending" || e.status === "verified") ? <div className="mt-3"><Field label="Note for the next action (optional)"><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={input} /></Field></div> : null}
      <Failure message={review.error} />
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="Add verified experience"><select value={tagId} onChange={(e) => setTagId(e.target.value)} className={input}><option value="">Choose…</option>{(tags.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.tagId} value={t.tagId}>{t.name}</option>)}</select></Field>
        <Button variant="secondary" disabled={!tagId} loading={add.busy} onClick={() => void add.run(() => api.post(`/v1/caregivers/${caregiverRecordId}/experience`, { organizationId: activeOrganizationId, tagId, context: null, verified: true }), "The experience was not added.", () => { setTagId(""); refresh(); })}>Add as verified</Button>
      </div>
      <Failure message={add.error} />
      <div className="mt-4 border-t border-slate-100 pt-3">
        <p className="text-sm text-slate-700">{reviewedAt ? `Experience profile marked reviewed ${formatDateTime(reviewedAt)}.` : "Experience profile not marked reviewed. Matching shows the experience score as incomplete until it is."}</p>
        <p className="mt-1 text-xs text-slate-500">Marking reviewed says you have checked this caregiver's list; tags not on it are then treated as not held.</p>
        <Failure message={mark.error} />
        <Button className="mt-2" variant="secondary" loading={mark.busy} onClick={() => void mark.run(() => api.post(`/v1/caregivers/${caregiverRecordId}/experience-reviewed`, { organizationId: activeOrganizationId }), "The profile was not marked reviewed.", refresh)}>Mark experience reviewed</Button>
      </div>
    </Card>
  );
}

function AdminLocationCard({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["cg-location", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ location: { zip: string; travelLimitMiles: number | null; updatedAt: string; coordinatesKnown: boolean } | null }>(`/v1/caregivers/${caregiverRecordId}/location`, { organizationId: activeOrganizationId })).location,
    enabled: !!activeOrganizationId,
  });
  const [zip, setZip] = useState<string | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const send = useSend();
  const zipValue = zip ?? q.data?.zip ?? "";
  const limitValue = limit ?? (q.data?.travelLimitMiles?.toString() ?? "");
  const okZip = /^\d{5}$/.test(zipValue);
  const okLimit = limitValue === "" || (/^\d+$/.test(limitValue) && Number(limitValue) >= 1 && Number(limitValue) <= 500);
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Location</h2>
      <p className="mt-1 text-sm text-slate-600">ZIP code only. Used for an approximate straight-line distance, not driving time. No street address is stored for matching.</p>
      <Loading q={q} what="location" />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field label="ZIP code"><input inputMode="numeric" maxLength={5} value={zipValue} onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} className={input} /></Field>
        <Field label="Travel limit in miles (optional)"><input inputMode="numeric" value={limitValue} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} className={input} /></Field>
      </div>
      {q.data && !q.data.coordinatesKnown ? <p role="note" className="mt-2 text-sm text-amber-900">This ZIP is not in the distance list, so distance will show as not available.</p> : null}
      {zip !== null && !okZip ? <p role="alert" className="mt-2 text-sm text-red-700">Enter a 5-digit ZIP code.</p> : null}
      <Failure message={send.error} />
      <Button className="mt-3" disabled={!okZip || !okLimit} loading={send.busy}
        onClick={() => void send.run(() => api.post(`/v1/caregivers/${caregiverRecordId}/location`, { organizationId: activeOrganizationId, zip: zipValue, travelLimitMiles: limitValue === "" ? null : Number(limitValue) }), "The location was not saved.", () => { setZip(null); setLimit(null); void qc.invalidateQueries({ queryKey: ["cg-location"] }); })}>Save location</Button>
    </Card>
  );
}

// ---------------------------------------------------------------- administrator: Care Team index

type ReviewRow = {
  requestId: string; caregiverRecordId: string; caregiverCode: string; caregiverName: string; status: string; reason: string;
  requestedAt: string; requestedByName: string | null; stale: boolean;
  proposedWindows: AvailWindow[] | null; proposedUnavailable: AvailUnavailable[] | null; currentWindows: AvailWindow[]; currentUnavailable: AvailUnavailable[];
};

export function AvailabilityReviewCard() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["availability-requests", activeOrganizationId],
    queryFn: async () => (await api.get<{ requests: ReviewRow[] }>("/v1/availability/requests", { organizationId: activeOrganizationId, status: "pending" })).requests,
    enabled: !!activeOrganizationId,
    refetchInterval: 30_000,
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const send = useSend();
  const decide = (r: ReviewRow, decision: "approve" | "decline") => {
    if (decision === "decline" && !(notes[r.requestId] ?? "").trim()) return;
    void send.run((k) => api.post(`/v1/availability/requests/${r.requestId}/review`, { decision, note: (notes[r.requestId] ?? "").trim() || null }, { idempotencyKey: k }), "The decision was not saved.", () => {
      void qc.invalidateQueries({ queryKey: ["availability-requests"] });
      void qc.invalidateQueries({ queryKey: ["cg-availability"] });
    });
  };
  const rows = q.data ?? [];
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Availability requests{rows.length ? ` (${rows.length})` : ""}</h2>
      <p className="mt-1 text-sm text-slate-600">Matching uses only approved availability. Declining needs a note so the caregiver knows why.</p>
      <Loading q={q} what="requests" />
      {q.data && rows.length === 0 ? <p className="mt-2 text-sm text-slate-500">No requests waiting.</p> : null}
      <ul className="mt-2 space-y-3">{rows.map((r) => (
        <li key={r.requestId} className="rounded-lg border border-slate-100 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="font-medium text-slate-900"><Link className="underline" to={`/care-team/${r.caregiverRecordId}`}>{r.caregiverName}</Link> <span className="text-xs text-slate-500">{r.caregiverCode}</span></p><p className="text-xs text-slate-500">Sent {formatDateTime(r.requestedAt)} · Reason: {r.reason}</p></div>
            <Button size="sm" variant="secondary" className="min-h-[40px]" aria-expanded={open === r.requestId} onClick={() => setOpen(open === r.requestId ? null : r.requestId)}>{open === r.requestId ? "Hide changes" : "Show changes"}</Button>
          </div>
          {r.stale ? <p role="note" className="mt-1 text-sm font-medium text-amber-900">Approved availability changed after this was sent. Compare before approving.</p> : null}
          {open === r.requestId ? <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div><p className="text-xs font-semibold text-slate-600">Approved now</p><AvailabilitySummary windows={r.currentWindows} unavailable={r.currentUnavailable} /></div>
            <div><p className="text-xs font-semibold text-slate-600">Requested</p><AvailabilitySummary windows={r.proposedWindows ?? r.currentWindows} unavailable={r.proposedUnavailable ?? r.currentUnavailable} /></div>
          </div> : null}
          <div className="mt-2"><Field label="Note (required to decline)"><input value={notes[r.requestId] ?? ""} maxLength={500} onChange={(e) => setNotes((n) => ({ ...n, [r.requestId]: e.target.value }))} className={input} /></Field></div>
          <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" className="min-h-[40px]" disabled={send.busy} onClick={() => decide(r, "approve")}>Approve</Button><Button size="sm" variant="secondary" className="min-h-[40px]" disabled={send.busy || !(notes[r.requestId] ?? "").trim()} onClick={() => decide(r, "decline")}>Decline</Button></div>
        </li>
      ))}</ul>
      <Failure message={send.error} />
    </Card>
  );
}

type Flag = { kind: string; shiftId: string | null; caregiverRecordId: string; caregiverName: string; clientCode: string; serviceName: string; startsAt: string; reasons: string[] };

export function ReadinessFlagsCard() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["readiness-flags", activeOrganizationId],
    queryFn: async () => (await api.get<{ flags: Flag[] }>("/v1/readiness/flags", { organizationId: activeOrganizationId, days: "90" })).flags,
    enabled: !!activeOrganizationId,
  });
  const rows = q.data ?? [];
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Upcoming services needing attention{rows.length ? ` (${rows.length})` : ""}</h2>
      <p className="mt-1 text-sm text-slate-600">Next 90 days. Existing schedules are never changed automatically; these are flagged for you to fix.</p>
      <Loading q={q} what="flags" />
      {q.data && rows.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nothing flagged.</p> : null}
      <ul className="mt-2 space-y-1">{rows.slice(0, 50).map((f, i) => <li key={`${f.shiftId ?? f.caregiverRecordId}-${i}`} className="text-sm"><Link className="font-medium underline" to={`/care-team/${f.caregiverRecordId}`}>{f.caregiverName}</Link> · {f.clientCode} · {f.serviceName} · {formatDateTime(f.startsAt)}<span className="block text-xs text-amber-900">{f.reasons.join(" · ")}</span></li>)}</ul>
    </Card>
  );
}

export function ReadinessSettingsCard() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["readiness-settings", activeOrganizationId],
    queryFn: async () => {
      const [r, m] = await Promise.all([
        api.get<{ readiness: { serviceChecksEnabled: boolean; availabilityRequired: boolean; expiryWarningDays: number } | null }>("/v1/readiness/settings", { organizationId: activeOrganizationId }),
        api.get<{ match: { referenceRadiusMiles: number; locationEnabled: boolean } | null }>("/v1/match/settings", { organizationId: activeOrganizationId }),
      ]);
      return { readiness: r.readiness, match: m.match };
    },
    enabled: !!activeOrganizationId,
  });
  const [draft, setDraft] = useState<{ serviceChecks: boolean; availabilityRequired: boolean; warn: string; radius: string; location: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const send = useSend();
  const r = q.data?.readiness;
  const m = q.data?.match;
  const v = draft ?? (r && m ? { serviceChecks: r.serviceChecksEnabled, availabilityRequired: r.availabilityRequired, warn: String(r.expiryWarningDays), radius: String(m.referenceRadiusMiles), location: m.locationEnabled } : null);
  const warnOk = !!v && /^\d+$/.test(v.warn) && Number(v.warn) >= 1 && Number(v.warn) <= 365;
  const radiusOk = !!v && Number(v.radius) > 0 && Number(v.radius) <= 500;
  const changed = !!draft && !!r && !!m && (draft.serviceChecks !== r.serviceChecksEnabled || draft.availabilityRequired !== r.availabilityRequired || Number(draft.warn) !== r.expiryWarningDays || Number(draft.radius) !== m.referenceRadiusMiles || draft.location !== m.locationEnabled);
  const set = (patch: Partial<NonNullable<typeof v>>) => v && setDraft({ ...v, ...patch });
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Readiness and matching settings</h2>
      <Loading q={q} what="settings" />
      {v ? <div className="mt-2 space-y-3">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={v.serviceChecks} onChange={(e) => set({ serviceChecks: e.target.checked })} /><span><span className="font-medium">Require explicit service approval</span><span className="block text-slate-600">Off: service approval shows as unchecked. On: a caregiver cannot be scheduled for a service without an approval covering the date. Turn on after approvals are entered; existing schedules are flagged, not changed.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={v.availabilityRequired} onChange={(e) => set({ availabilityRequired: e.target.checked })} /><span><span className="font-medium">Require approved availability</span><span className="block text-slate-600">On: a caregiver with no approved availability cannot be scheduled without an audited override.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={v.location} onChange={(e) => set({ location: e.target.checked })} /><span><span className="font-medium">Use location in the match score</span><span className="block text-slate-600">Off: the score uses availability and experience only.</span></span></label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Reference radius in miles"><input inputMode="decimal" value={v.radius} onChange={(e) => set({ radius: e.target.value })} className={input} /></Field>
          <Field label="Warn this many days before a document expires"><input inputMode="numeric" value={v.warn} onChange={(e) => set({ warn: e.target.value.replace(/\D/g, "") })} className={input} /></Field>
        </div>
        <Field label="Reason for the change (required)"><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} /></Field>
        <Failure message={send.error} />
        <Button disabled={!changed || !warnOk || !radiusOk || !reason.trim()} loading={send.busy}
          onClick={() => void send.run(async () => {
            const org = activeOrganizationId;
            // Only the group that changed is sent, so a failure cannot leave the other group half-saved.
            if (r && (v.serviceChecks !== r.serviceChecksEnabled || v.availabilityRequired !== r.availabilityRequired || Number(v.warn) !== r.expiryWarningDays)) {
              await api.post("/v1/readiness/settings", { organizationId: org, serviceChecksEnabled: v.serviceChecks, availabilityRequired: v.availabilityRequired, expiryWarningDays: Number(v.warn), reason: reason.trim() });
            }
            if (m && (Number(v.radius) !== m.referenceRadiusMiles || v.location !== m.locationEnabled)) {
              await api.post("/v1/match/settings", { organizationId: org, referenceRadiusMiles: Number(v.radius), locationEnabled: v.location, reason: reason.trim() });
            }
          }, "The settings were not saved.", () => { setDraft(null); setReason(""); void qc.invalidateQueries({ queryKey: ["readiness-settings"] }); })}>Save settings</Button>
      </div> : null}
    </Card>
  );
}

// ---------------------------------------------------------------- administrator: one client

type Preference = { preferenceId: string; tagId: string; tagName: string; weight: number; mandatory: boolean; confirmedAt: string; confirmedByName: string | null };

/** Client support needs: confirmed by an administrator. Optional ones add to the score; mandatory ones are a hard check. */
export function ClientSupportCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const prefs = useQuery({
    queryKey: ["client-support", activeOrganizationId, clientId],
    queryFn: async () => (await api.get<{ preferences: Preference[] }>(`/v1/clients/${clientId}/support-preferences`, { organizationId: activeOrganizationId })).preferences,
    enabled: !!activeOrganizationId,
  });
  const tags = useTags();
  const [tagId, setTagId] = useState("");
  const [weight, setWeight] = useState("3");
  const [mandatory, setMandatory] = useState(false);
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const add = useSend();
  const remove = useSend();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["client-support"] });
  const taken = new Set((prefs.data ?? []).map((p) => p.tagId));
  const weightOk = /^\d+$/.test(weight) && Number(weight) >= 1 && Number(weight) <= 10;
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Support needs</h2>
      <p className="mt-1 text-sm text-slate-600">Confirm what support this client needs. Optional needs raise the match score for caregivers with that verified experience. A mandatory need is a requirement: a caregiver without it cannot be scheduled, and an override cannot waive it.</p>
      <Loading q={prefs} what="support needs" />
      {prefs.data && prefs.data.length === 0 ? <p className="mt-2 text-sm text-slate-500">None confirmed. Matching then ignores experience for this client.</p> : null}
      <ul className="mt-2 space-y-2">{(prefs.data ?? []).map((p) => (
        <li key={p.preferenceId} className="rounded-lg border border-slate-100 p-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{p.tagName}</span><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.mandatory ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-800"}`}>{p.mandatory ? "Mandatory" : `Optional · importance ${p.weight}`}</span></div>
          <p className="text-xs text-slate-500">Confirmed {formatDateTime(p.confirmedAt)}{p.confirmedByName ? ` by ${p.confirmedByName}` : ""}</p>
          {removing === p.preferenceId ? <div className="mt-2 space-y-2">
            <Field label="Reason for removing (required)"><input value={removeReason} maxLength={500} onChange={(e) => setRemoveReason(e.target.value)} className={input} /></Field>
            <Failure message={remove.error} />
            <div className="flex gap-2"><Button size="sm" loading={remove.busy} disabled={removeReason.trim().length < 3} onClick={() => void remove.run(() => api.post(`/v1/support-preferences/${p.preferenceId}/remove`, { reason: removeReason.trim() }), "The need was not removed.", () => { setRemoving(null); setRemoveReason(""); refresh(); })}>Remove</Button><Button size="sm" variant="secondary" onClick={() => { setRemoving(null); remove.clear(); }}>Cancel</Button></div>
          </div> : <Button size="sm" variant="secondary" className="mt-2 min-h-[40px]" onClick={() => { setRemoving(p.preferenceId); setRemoveReason(""); remove.clear(); }}>Remove</Button>}
        </li>
      ))}</ul>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">Confirm a need</h3>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        <Field label="Need"><select value={tagId} onChange={(e) => setTagId(e.target.value)} className={input}><option value="">Choose…</option>{(tags.data ?? []).filter((t) => t.isActive && !taken.has(t.tagId)).map((t) => <option key={t.tagId} value={t.tagId}>{t.name}</option>)}</select></Field>
        <Field label="Importance, 1 to 10 (optional needs)"><input inputMode="numeric" value={weight} disabled={mandatory} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ""))} className={input} /></Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />Mandatory (a hard requirement, not a score)</label>
      <div className="mt-2"><Field label="Reason (required)"><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} /></Field></div>
      <Failure message={add.error} />
      <Button className="mt-3" disabled={!tagId || !reason.trim() || (!mandatory && !weightOk)} loading={add.busy}
        onClick={() => void add.run(() => api.post(`/v1/clients/${clientId}/support-preferences`, { organizationId: activeOrganizationId, tagId, weight: mandatory ? 1 : Number(weight), mandatory, reason: reason.trim() }), "The need was not saved.", () => { setTagId(""); setReason(""); setMandatory(false); setWeight("3"); refresh(); })}>Confirm need</Button>
    </Card>
  );
}

export function ClientLocationCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["client-location", activeOrganizationId, clientId],
    queryFn: async () => (await api.get<{ location: { zip: string; coordinatesKnown: boolean } | null }>(`/v1/clients/${clientId}/location`, { organizationId: activeOrganizationId })).location,
    enabled: !!activeOrganizationId,
  });
  const [zip, setZip] = useState<string | null>(null);
  const send = useSend();
  const value = zip ?? q.data?.zip ?? "";
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Service location</h2>
      <p className="mt-1 text-sm text-slate-600">ZIP code only, for an approximate distance to caregivers. Not shown to caregivers.</p>
      <Loading q={q} what="location" />
      <div className="mt-2 max-w-xs"><Field label="ZIP code"><input inputMode="numeric" maxLength={5} value={value} onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} className={input} /></Field></div>
      {q.data && !q.data.coordinatesKnown ? <p role="note" className="mt-2 text-sm text-amber-900">This ZIP is not in the distance list, so distance will show as not available.</p> : null}
      <Failure message={send.error} />
      <Button className="mt-3" disabled={!/^\d{5}$/.test(value) || zip === null} loading={send.busy}
        onClick={() => void send.run(() => api.post(`/v1/clients/${clientId}/location`, { organizationId: activeOrganizationId, zip: value }), "The location was not saved.", () => { setZip(null); void qc.invalidateQueries({ queryKey: ["client-location"] }); })}>Save location</Button>
    </Card>
  );
}

/** The agency's own list of experience tags. None are seeded: an agency adds only what it will actually verify. */
export function ExperienceTagsCard() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const tags = useTags();
  const [name, setName] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const add = useSend();
  const toggle = useSend();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["experience-tags"] });
  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-950">Experience tags</h2>
      <p className="mt-1 text-sm text-slate-600">The skills and situations you will verify and match on, for example “Dementia care”. Nothing is pre-loaded. Turning a tag off keeps past records.</p>
      <Loading q={tags} what="tags" />
      {tags.data && tags.data.length === 0 ? <p className="mt-2 text-sm text-slate-500">No tags yet. Experience and client support needs cannot be recorded until you add some.</p> : null}
      <ul className="mt-2 space-y-1">{(tags.data ?? []).map((t) => (
        <li key={t.tagId} className="text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className={t.isActive ? "" : "text-slate-500 line-through"}>{t.name}</span>
            <button type="button" className="min-h-[40px] text-sm underline" aria-expanded={changing === t.tagId} onClick={() => { setChanging(changing === t.tagId ? null : t.tagId); setReason(""); toggle.clear(); }}>{t.isActive ? "Turn off" : "Turn on"}</button></div>
          {changing === t.tagId ? <div className="mt-1 space-y-2 rounded-lg bg-slate-50 p-2">
            <Field label="Reason (required)"><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={input} /></Field>
            <Failure message={toggle.error} />
            <Button size="sm" loading={toggle.busy} disabled={reason.trim().length < 3} onClick={() => void toggle.run(() => api.post(`/v1/experience-tags/${t.tagId}/active`, { organizationId: activeOrganizationId, active: !t.isActive, reason: reason.trim() }), "The tag was not changed.", () => { setChanging(null); refresh(); })}>{t.isActive ? "Turn off" : "Turn on"}</Button>
          </div> : null}
        </li>
      ))}</ul>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="New tag"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={input} /></Field>
        <Button variant="secondary" disabled={name.trim().length < 2} loading={add.busy} onClick={() => void add.run(() => api.post("/v1/experience-tags", { organizationId: activeOrganizationId, name: name.trim() }), "The tag was not added.", () => { setName(""); refresh(); })}>Add tag</Button>
      </div>
      <Failure message={add.error} />
    </Card>
  );
}
