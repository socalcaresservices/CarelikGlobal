import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const field = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";

interface Settings {
  openShiftsEnabled: boolean; smsEnabled: boolean; smsEntitled: boolean; senderStatus: string; smsAvailable: boolean; smsDisplayName: string | null;
  monthlySendLimit: number; alertWindowDays: number; quietStart: string; quietEnd: string; urgentHours: number; escalationHours: number; officeOpen: string; officeClose: string;
  usage: { period: string; sent: number; segments: number; blocked: number; failed: number };
}
interface Contact { contactId: string; label: string; phoneMasked: string | null; email: string | null; notifySms: boolean; notifyEmail: boolean; isOnCall: boolean; active: boolean }
interface CaregiverRow { caregiverRecordId: string; caregiverCode: string; displayName?: string | null; firstName?: string | null; lastName?: string | null }

function CityRow({ c }: { c: CaregiverRow }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<{ error: string | null; done: boolean }>({ error: null, done: false });
  const cities = useQuery({
    queryKey: ["aws-coverage-cities", activeOrganizationId, c.caregiverRecordId],
    queryFn: async () => (await api.get<{ cities: Array<{ city: string; state: string }> }>(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/coverage-cities`, { organizationId: activeOrganizationId })).cities,
    enabled: !!activeOrganizationId,
  });
  const shown = text ?? (cities.data ?? []).map((x) => x.city).join(", ");
  async function save() {
    setState({ error: null, done: false });
    try {
      const list = shown.split(",").map((s) => s.trim()).filter(Boolean).map((city) => ({ city, state: "CA" }));
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/coverage-cities`, { organizationId: activeOrganizationId, cities: list });
      setText(null);
      setState({ error: null, done: true });
      await queryClient.invalidateQueries({ queryKey: ["aws-coverage-cities"] });
    } catch (cause) { setState({ error: message(cause, "Not saved."), done: false }); }
  }
  const name = c.displayName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || c.caregiverCode);
  return (
    <li className="flex flex-wrap items-end gap-2 py-2 text-sm">
      <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">{name} ({c.caregiverCode})
        <input value={shown} onChange={(e) => { setText(e.target.value); setState({ error: null, done: false }); }} placeholder="Winchester, Temecula" className={field} />
      </label>
      <Button type="button" variant="secondary" className="min-h-11" disabled={text === null} onClick={() => void save()}>Save cities</Button>
      {state.error ? <p role="alert" className="w-full text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="w-full text-emerald-800">Saved.</p> : null}
    </li>
  );
}

/** Agency owner: Open Shifts and text settings, office contacts and each caregiver's approved cities. */
export function OpenShiftSettingsPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canEdit = hasPermission("organization.update");
  const [form, setForm] = useState<Partial<Settings> | null>(null);
  const [state, setState] = useState<{ error: string | null; done: string | null }>({ error: null, done: null });
  const [contact, setContact] = useState({ label: "", phone: "", isOnCall: false });
  const settings = useQuery({
    queryKey: ["aws-open-shift-settings", activeOrganizationId],
    queryFn: async () => (await api.get<{ settings: Settings }>("/v1/open-shift-settings", { organizationId: activeOrganizationId })).settings,
    enabled: !!activeOrganizationId,
  });
  const contacts = useQuery({
    queryKey: ["aws-office-contacts", activeOrganizationId],
    queryFn: async () => (await api.get<{ contacts: Contact[] }>("/v1/office-contacts", { organizationId: activeOrganizationId })).contacts,
    enabled: !!activeOrganizationId && canEdit,
  });
  const caregivers = useQuery({
    queryKey: ["aws-caregivers-for-cities", activeOrganizationId],
    queryFn: async () => (await api.get<{ caregivers: CaregiverRow[] }>("/v1/caregivers", { organizationId: activeOrganizationId })).caregivers,
    enabled: !!activeOrganizationId,
  });
  const audit = useQuery({
    queryKey: ["aws-open-shift-audit", activeOrganizationId],
    queryFn: async () => (await api.get<{ events: Array<{ occurredAt: string; action: string; actorName: string | null; reason: string | null }> }>("/v1/open-shift-audit", { organizationId: activeOrganizationId })).events,
    enabled: !!activeOrganizationId && canEdit,
  });
  const s = settings.data;
  const v = <K extends keyof Settings>(k: K) => (form && k in form ? form[k] : s?.[k]) as Settings[K];
  async function save() {
    setState({ error: null, done: null });
    try {
      await api.post("/v1/open-shift-settings", { organizationId: activeOrganizationId, ...form });
      setForm(null);
      setState({ error: null, done: "Saved." });
      await queryClient.invalidateQueries({ queryKey: ["aws-open-shift-settings"] });
    } catch (cause) { setState({ error: message(cause, "Not saved."), done: null }); }
  }
  async function addContact() {
    setState({ error: null, done: null });
    try {
      await api.post("/v1/office-contacts", { organizationId: activeOrganizationId, label: contact.label, phone: contact.phone, notifySms: true, isOnCall: contact.isOnCall, active: true });
      setContact({ label: "", phone: "", isOnCall: false });
      await queryClient.invalidateQueries({ queryKey: ["aws-office-contacts"] });
    } catch (cause) { setState({ error: message(cause, "Contact not saved."), done: null }); }
  }
  if (!canEdit) return <p className="text-sm text-slate-700">Only an agency administrator can change these settings.</p>;
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-950">Open shifts and text settings</h1>
      {settings.isError ? <p role="alert" className="text-sm text-red-700">Settings could not be loaded.</p> : null}
      {s ? (
        <section className="space-y-2 rounded-lg border border-slate-200 bg-og-card p-3 text-sm" aria-labelledby="sms-settings">
          <h2 id="sms-settings" className="text-base font-semibold text-slate-950">Text messages</h2>
          <p data-testid="sms-status">{s.smsAvailable ? "Texting is on." : !s.smsEntitled ? "Texting is not part of this agency's plan yet." : s.senderStatus !== "verified" ? "Texting is waiting for the sender number to be verified." : "Texting is switched off."} The Open Shifts board and office approval work without it.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={v("smsEnabled")} onChange={(e) => setForm({ ...form, smsEnabled: e.target.checked })} /> Send texts for this agency</label>
          <label className="block text-xs font-medium text-slate-600">Name shown at the start of each text
            <input value={v("smsDisplayName") ?? ""} maxLength={60} onChange={(e) => setForm({ ...form, smsDisplayName: e.target.value })} className={field} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-medium text-slate-600">Monthly text limit
              <input type="number" min={0} value={v("monthlySendLimit")} onChange={(e) => setForm({ ...form, monthlySendLimit: Number(e.target.value) })} className={field} /></label>
            <label className="text-xs font-medium text-slate-600">Alert window (days ahead)
              <input type="number" min={1} max={60} value={v("alertWindowDays")} onChange={(e) => setForm({ ...form, alertWindowDays: Number(e.target.value) })} className={field} /></label>
            <label className="text-xs font-medium text-slate-600">Quiet hours start
              <input type="time" value={v("quietStart")} onChange={(e) => setForm({ ...form, quietStart: e.target.value })} className={field} /></label>
            <label className="text-xs font-medium text-slate-600">Quiet hours end
              <input type="time" value={v("quietEnd")} onChange={(e) => setForm({ ...form, quietEnd: e.target.value })} className={field} /></label>
            <label className="text-xs font-medium text-slate-600">Urgent when starting within (hours)
              <input type="number" min={1} value={v("urgentHours")} onChange={(e) => setForm({ ...form, urgentHours: Number(e.target.value) })} className={field} /></label>
            <label className="text-xs font-medium text-slate-600">Escalate unfilled openings (hours before start)
              <input type="number" min={1} value={v("escalationHours")} onChange={(e) => setForm({ ...form, escalationHours: Number(e.target.value) })} className={field} /></label>
          </div>
          <p data-testid="sms-usage">This month: {s.usage.sent} of {s.monthlySendLimit} texts used, {s.usage.blocked} blocked by the limit, {s.usage.failed} failed.</p>
          {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-emerald-800">{state.done}</p> : null}
          <Button type="button" className="min-h-11" disabled={form === null} onClick={() => void save()}>Save settings</Button>
        </section>
      ) : null}
      <section className="space-y-2 rounded-lg border border-slate-200 bg-og-card p-3 text-sm" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading" className="text-base font-semibold text-slate-950">Office contacts for coverage alerts</h2>
        <p className="text-slate-700">Being listed here gives no Ogevia access. One on-call number receives alerts outside office hours.</p>
        <ul className="divide-y divide-slate-200" data-testid="contact-list">
          {(contacts.data ?? []).map((c) => <li key={c.contactId} className="py-1">{c.label} · {c.phoneMasked ?? "no number"}{c.isOnCall ? " · on-call" : ""}{c.active ? "" : " · inactive"}</li>)}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-600">Name<input value={contact.label} maxLength={80} onChange={(e) => setContact({ ...contact, label: e.target.value })} className={field} /></label>
          <label className="text-xs font-medium text-slate-600">Mobile number<input value={contact.phone} inputMode="tel" maxLength={25} onChange={(e) => setContact({ ...contact, phone: e.target.value })} className={field} /></label>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={contact.isOnCall} onChange={(e) => setContact({ ...contact, isOnCall: e.target.checked })} /> On-call</label>
          <Button type="button" className="min-h-11" disabled={contact.label.trim().length < 2 || contact.phone.trim().length < 7} onClick={() => void addContact()}>Add contact</Button>
        </div>
      </section>
      <section className="rounded-lg border border-slate-200 bg-og-card p-3 text-sm" aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="text-base font-semibold text-slate-950">Recent activity</h2>
        <ul className="divide-y divide-slate-200" data-testid="audit-list">
          {(audit.data ?? []).slice(0, 25).map((e, i) => <li key={i} className="py-1">{new Date(e.occurredAt).toLocaleString()} · {e.action.replace(/^shift\./, "").replace(/_/g, " ")}{e.actorName ? ` · ${e.actorName}` : ""}{e.reason ? ` · ${e.reason}` : ""}</li>)}
          {audit.data && audit.data.length === 0 ? <li className="py-1 text-slate-600">Nothing yet.</li> : null}
        </ul>
      </section>
      <section className="rounded-lg border border-slate-200 bg-og-card p-3" aria-labelledby="cities-heading">
        <h2 id="cities-heading" className="text-base font-semibold text-slate-950">Cities each caregiver is approved to work</h2>
        <p className="text-sm text-slate-700">Separate cities with commas. Caregivers only see openings in these cities.</p>
        <ul className="divide-y divide-slate-200">{(caregivers.data ?? []).map((c) => <CityRow key={c.caregiverRecordId} c={c} />)}</ul>
      </section>
    </div>
  );
}
