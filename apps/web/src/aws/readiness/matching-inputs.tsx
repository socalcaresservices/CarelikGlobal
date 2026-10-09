import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "./format";
import { useGuardedMutate } from "./use-guarded";

type Tag = { tagId: string; label: string };
type Experience = { reviewed: boolean; reviewedAt: string | null; tags: { tagId: string; label: string; status: string }[] };
type Requirement = { tagId: string; label: string; mandatory: boolean };
const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base";

function useTags() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({ queryKey: ["experience-tags", activeOrganizationId], queryFn: async () => (await api.get<{ tags: Tag[] }>("/v1/experience-tags", { organizationId: activeOrganizationId })).tags, enabled: !!activeOrganizationId });
}

function NewTag() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [label, setLabel] = useState("");
  const add = useMutation({ mutationFn: () => api.post("/v1/experience-tags", { organizationId: activeOrganizationId, label: label.trim() }), onSuccess: () => { setLabel(""); void qc.invalidateQueries({ queryKey: ["experience-tags"] }); } });
  const send = useGuardedMutate(add);
  return <form className="space-y-2 rounded-md bg-slate-50 p-3" onSubmit={(e) => { e.preventDefault(); if (label.trim().length >= 2) send(); }}>
    <label className="block text-sm">New experience tag<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className={inputClass} /></label>
    {add.isError ? <p role="alert" className="text-sm text-red-700">{actionError(add.error, "Tag could not be added.")}</p> : null}
    <Button type="submit" variant="secondary" disabled={add.isPending || label.trim().length < 2}>Add tag</Button>
  </form>;
}

function ExperienceForm({ caregiverRecordId, tags, current, onDone }: { caregiverRecordId: string; tags: Tag[]; current: Experience; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [selected, setSelected] = useState(() => new Set(current.tags.filter((t) => t.status === "confirmed").map((t) => t.tagId)));
  const [note, setNote] = useState("");
  const save = useMutation({ mutationFn: () => api.post(`/v1/caregivers/${caregiverRecordId}/experience/review`, { organizationId: activeOrganizationId, confirmedTagIds: [...selected], note: note.trim() }), onSuccess: onDone });
  const send = useGuardedMutate(save);
  return <form className="space-y-3" aria-label="Review caregiver experience" onSubmit={(e) => { e.preventDefault(); if (note.trim().length >= 3) send(); }}>
    <fieldset><legend className="text-sm font-medium">Confirmed experience</legend>
      {tags.length === 0 ? <p className="text-sm text-slate-600">No experience tags yet.</p> : tags.map((t) => <label key={t.tagId} className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" checked={selected.has(t.tagId)} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(t.tagId); else next.delete(t.tagId); return next; })} />{t.label}</label>)}
    </fieldset>
    <p className="text-xs text-slate-600">Saving with no tags records a review with no confirmed experience. Experience tags do not establish certification.</p>
    <label className="block text-sm">Review note<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className={inputClass} /></label>
    {save.isError ? <p role="alert" className="text-sm text-red-700">{actionError(save.error, "Experience could not be saved.")}</p> : null}
    <Button type="submit" disabled={save.isPending || note.trim().length < 3}>Save review</Button>
  </form>;
}

export function CaregiverExperience({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const tags = useTags();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ["caregiver-experience", activeOrganizationId, caregiverRecordId], queryFn: async () => (await api.get<{ experience: Experience }>(`/v1/caregivers/${caregiverRecordId}/experience`, { organizationId: activeOrganizationId })).experience, enabled: !!activeOrganizationId });
  return <Card className="space-y-3 p-4"><h2 className="text-base font-semibold text-slate-950">Experience</h2>
    {q.isLoading ? <p role="status">Loading…</p> : null}
    {q.isError || tags.isError ? <p role="alert">{actionError(q.error ?? tags.error, "Experience could not be loaded.")}</p> : null}
    {q.data ? <><p className="text-sm">{q.data.reviewed ? "Reviewed" : "Needs review"}</p>
      {q.data.tags.length ? <ul className="text-sm">{q.data.tags.map((t) => <li key={t.tagId}>{t.label} · {t.status === "reported" ? "Caregiver-reported" : t.status === "confirmed" ? "Confirmed" : "Not confirmed"}</li>)}</ul> : <p className="text-sm text-slate-600">Not provided</p>}
      {hasPermission("matching.manage") && tags.data ? <><Button type="button" variant="secondary" aria-expanded={editing} onClick={() => { setEditing((v) => !v); setSaved(false); }}>{editing ? "Close review" : "Review experience"}</Button>
        {editing ? <><ExperienceForm caregiverRecordId={caregiverRecordId} tags={tags.data} current={q.data} onDone={() => { setEditing(false); setSaved(true); void qc.invalidateQueries({ queryKey: ["caregiver-experience"] }); void qc.invalidateQueries({ queryKey: ["care-matches"] }); }} /><NewTag /></> : null}</> : null}
    </> : null}
    {saved ? <p role="status" className="text-sm">Experience review saved.</p> : null}
  </Card>;
}

function RequirementsForm({ clientId, tags, current, onDone }: { clientId: string; tags: Tag[]; current: Requirement[]; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [values, setValues] = useState<Record<string, "optional" | "mandatory" | "none">>(() => Object.fromEntries(current.map((r) => [r.tagId, r.mandatory ? "mandatory" : "optional"])));
  const [reason, setReason] = useState("");
  const save = useMutation({ mutationFn: () => api.post(`/v1/clients/${clientId}/experience-requirements`, { organizationId: activeOrganizationId, requirements: Object.entries(values).filter(([, v]) => v !== "none").map(([tagId, v]) => ({ tagId, mandatory: v === "mandatory" })), reason: reason.trim() }), onSuccess: onDone });
  const send = useGuardedMutate(save);
  return <form className="space-y-3" aria-label="Client experience preferences" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) send(); }}>
    <p className="text-xs text-slate-600">Optional preferences affect matching only. Mandatory requirements block assignments until confirmed.</p>
    {tags.map((t) => <label key={t.tagId} className="block text-sm">{t.label}<select className={inputClass} value={values[t.tagId] ?? "none"} onChange={(e) => setValues((old) => ({ ...old, [t.tagId]: e.target.value as "optional" | "mandatory" | "none" }))}><option value="none">Not requested</option><option value="optional">Optional preference</option><option value="mandatory">Mandatory requirement</option></select></label>)}
    <label className="block text-sm">Reason for preferences<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={inputClass} /></label>
    {save.isError ? <p role="alert">{actionError(save.error, "Preferences could not be saved.")}</p> : null}
    <Button type="submit" disabled={save.isPending || reason.trim().length < 3}>Save preferences</Button>
  </form>;
}

export function ClientExperience({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const tags = useTags();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ["client-experience", activeOrganizationId, clientId], queryFn: async () => (await api.get<{ requirements: Requirement[] }>(`/v1/clients/${clientId}/experience-requirements`, { organizationId: activeOrganizationId })).requirements, enabled: !!activeOrganizationId });
  return <Card className="space-y-3 p-4"><h2 className="text-base font-semibold text-slate-950">Experience preferences</h2>
    {q.isLoading ? <p role="status">Loading…</p> : null}
    {q.isError || tags.isError ? <p role="alert">{actionError(q.error ?? tags.error, "Preferences could not be loaded.")}</p> : null}
    {q.data ? <>{q.data.length ? <ul className="text-sm">{q.data.map((r) => <li key={r.tagId}>{r.label} · {r.mandatory ? "Mandatory" : "Optional"}</li>)}</ul> : <p className="text-sm">Not provided</p>}
      {hasPermission("matching.manage") && tags.data ? <><Button variant="secondary" type="button" aria-expanded={editing} onClick={() => { setEditing((v) => !v); setSaved(false); }}>{editing ? "Close preferences" : "Edit preferences"}</Button>
        {editing ? <><RequirementsForm clientId={clientId} tags={tags.data} current={q.data} onDone={() => { setEditing(false); setSaved(true); void qc.invalidateQueries({ queryKey: ["client-experience"] }); void qc.invalidateQueries({ queryKey: ["care-matches"] }); }} /><NewTag /></> : null}</> : null}
    </> : null}
    {saved ? <p role="status">Preferences saved. Future assignments use the current requirements.</p> : null}
  </Card>;
}

function LocationForm({ path, current, onDone }: { path: string; current: string | null; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [zip, setZip] = useState(current ?? "");
  const save = useMutation({ mutationFn: () => api.post(path, { organizationId: activeOrganizationId, zip }), onSuccess: onDone });
  const send = useGuardedMutate(save);
  return <form className="space-y-2" aria-label="Location input" onSubmit={(e) => { e.preventDefault(); if (/^\d{5}$/.test(zip)) send(); }}>
    <label className="block text-sm">ZIP code<input inputMode="numeric" autoComplete="off" pattern="[0-9]{5}" maxLength={5} value={zip} onChange={(e) => setZip(e.target.value)} className={inputClass} /></label>
    <p className="text-xs text-slate-600">Enter a ZIP only. No street address is needed.</p>
    {save.isError ? <p role="alert">{actionError(save.error, "Location could not be saved.")}</p> : null}
    <Button type="submit" disabled={save.isPending || !/^\d{5}$/.test(zip)}>Save location</Button>
  </form>;
}

export function MatchingLocation({ caregiverRecordId, clientId }: { caregiverRecordId?: string; clientId?: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const path = caregiverRecordId ? `/v1/caregivers/${caregiverRecordId}/zip` : `/v1/clients/${clientId}/zip`;
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ["matching-location", activeOrganizationId, path], queryFn: async () => (await api.get<{ location: { zip: string | null } }>(path, { organizationId: activeOrganizationId })).location, enabled: !!activeOrganizationId });
  const status = useQuery({ queryKey: ["location-data", activeOrganizationId], queryFn: async () => (await api.get<{ status: { distanceDataLoaded: boolean } }>("/v1/location-data", { organizationId: activeOrganizationId })).status, enabled: !!activeOrganizationId });
  return <Card className="space-y-3 p-4"><h2 className="text-base font-semibold text-slate-950">Location</h2>
    {q.isLoading ? <p role="status">Loading…</p> : null}
    {q.isError || status.isError ? <p role="alert">{actionError(q.error ?? status.error, "Location could not be loaded.")}</p> : null}
    {q.data ? <><p className="text-sm">ZIP: {q.data.zip ?? "Not provided"}</p><Button type="button" variant="secondary" aria-expanded={editing} onClick={() => { setEditing((v) => !v); setSaved(false); }}>{editing ? "Close location" : "Edit location"}</Button>
      {editing ? <LocationForm path={path} current={q.data.zip} onDone={() => { setEditing(false); setSaved(true); void qc.invalidateQueries({ queryKey: ["matching-location"] }); void qc.invalidateQueries({ queryKey: ["location-data"] }); void qc.invalidateQueries({ queryKey: ["care-matches"] }); }} /> : null}</> : null}
    <p className="text-xs text-slate-600">{status.data ? status.data.distanceDataLoaded ? "Approx. distance uses ZIP centres and is not a travel limit." : "Approx. distance unavailable. No distance dataset is loaded; a ZIP alone does not provide distance." : "Distance data has not been verified."}</p>
    {saved ? <p role="status">Location saved.</p> : null}
  </Card>;
}
