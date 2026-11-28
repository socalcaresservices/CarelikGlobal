// Automatic texting for open shifts (0117, behind the `openShiftSms` release switch; the MOCK sender only: nothing is sent anywhere yet).
// Two panels: the person's own opt-in (number and consent, STOP), and for the agency owner the sender settings, limits, quiet hours, on-call numbers and what was queued.
// Where the switch is off the routes do not exist and both panels render nothing.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base";
const checkClass = "flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]";

export interface MySms { available: boolean; status: "none" | "opted_in" | "opted_out"; phoneLast4: string | null }
export interface SmsSettings {
  enabled: boolean; provider: "mock" | "live"; senderLabel: string; senderId: string | null; senderVerified: boolean;
  dailyLimit: number; hourlyLimit: number; perRecipientDaily: number; quietStart: string; quietEnd: string; recruitmentDays: number; escalationHours: number;
  recruitOn: boolean; receiptOn: boolean; cancelOn: boolean; confirmOn: boolean; officeOn: boolean; sentToday: number; liveSending: boolean;
}
interface OnCall { id: string; officeId: string | null; officeName: string | null; label: string; phoneLast4: string; active: boolean }
interface SmsRow { id: string; purpose: string; recipientKind: string; status: string; reason: string | null; shiftId: string | null; round: number; phoneLast4: string; createdAt: string; provider: string }
const PURPOSE: Record<string, string> = { recruitment: "Open-shift offer", callout_receipt: "Call-out receipt", cancel_notice: "Cancellation notice", filled_confirmation: "Confirmation", office_alert: "Office call-out alert", escalation: "Escalation" };
const STATUS: Record<string, string> = { queued: "Waiting", sending: "Sending", retry: "Will retry", sent: "Sent (test sender)", failed: "Failed", cancelled: "Stopped", skipped_limit: "Over the limit", skipped_opted_out: "Opted out" };

/** The person's own number and consent. Texts go only to someone who said yes here; replying STOP also stops them. */
export function MySmsPanel() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [phone, setPhone] = useState("");
  const [agree, setAgree] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ["my-sms", activeOrganizationId], queryFn: async () => (await api.get<{ sms: MySms }>("/v1/my-sms", { organizationId: activeOrganizationId })).sms, enabled: !!activeOrganizationId, retry: false });
  if (q.isLoading || q.isError || !q.data || !q.data.available) return null;
  const s = q.data;
  async function save(consent: boolean) {
    setNote(null);
    try {
      await api.post("/v1/my-sms", { organizationId: activeOrganizationId, consent, ...(consent ? { phone, consentVersion: "v1" } : {}) }, { idempotencyKey: newIdempotencyKey() });
      await queryClient.invalidateQueries({ queryKey: ["my-sms"] });
      setPhone(""); setAgree(false);
      setNote({ ok: true, text: consent ? "Saved. You will get open-shift texts at this number." : "You will not get texts." });
    } catch (cause) { setNote({ ok: false, text: message(cause, "Could not save. Nothing changed.") }); }
  }
  return (
    <Card>
      <h2 className="text-base font-semibold text-og-ink">Text messages about open shifts</h2>
      {s.status === "opted_in" ? (
        <div className="mt-2 space-y-2" data-testid="my-sms-on">
          <p className="text-sm">Texts go to the number ending <strong>{s.phoneLast4}</strong>. Reply STOP to any text to stop them.</p>
          <Button type="button" variant="secondary" className="min-h-11" onClick={() => void save(false)} data-testid="my-sms-off">Stop texts</Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2" data-testid="my-sms-form">
          {s.status === "opted_out" ? <p className="text-sm text-amber-900">Texts are off for you. Turn them on again below if you want.</p> : null}
          <label className="block text-sm">Mobile number<input className={inputClass} inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(951) 555-0123" data-testid="my-sms-phone" /></label>
          <label className={checkClass}><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} data-testid="my-sms-agree" /> <span>Yes, text me about open shifts and my own shifts. Message and data rates may apply. Reply STOP to stop at any time. No client names are ever texted.</span></label>
          <Button type="button" className="min-h-11" disabled={!agree || phone.trim().length < 7} onClick={() => void save(true)} data-testid="my-sms-save">Turn on texts</Button>
        </div>
      )}
      {note ? <p role={note.ok ? "status" : "alert"} className={`mt-1 text-sm ${note.ok ? "text-og-sub" : "text-red-700"}`}>{note.text}</p> : null}
    </Card>
  );
}

/** The agency's own sender settings and limits (each agency has its own), on-call numbers, and what was queued. Only the owner edits. */
export function OfficeSmsPanel() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const isOwner = hasPermission("organization.update");
  const settings = useQuery({ queryKey: ["sms-settings", activeOrganizationId], queryFn: async () => (await api.get<{ settings: SmsSettings }>("/v1/sms-settings", { organizationId: activeOrganizationId })).settings, enabled: !!activeOrganizationId, retry: false });
  const oncall = useQuery({ queryKey: ["sms-oncall", activeOrganizationId], queryFn: async () => (await api.get<{ contacts: OnCall[] }>("/v1/sms-oncall", { organizationId: activeOrganizationId })).contacts, enabled: !!settings.data, retry: false });
  const history = useQuery({ queryKey: ["sms-history", activeOrganizationId], queryFn: async () => (await api.get<{ messages: SmsRow[] }>("/v1/sms-history", { organizationId: activeOrganizationId })).messages, enabled: !!settings.data, retry: false });
  const [draft, setDraft] = useState<SmsSettings | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [nc, setNc] = useState({ label: "", phone: "" });
  if (settings.isLoading || settings.isError || !settings.data) return null;
  const s = draft ?? settings.data;
  const set = (patch: Partial<SmsSettings>) => setDraft({ ...s, ...patch });
  async function save() {
    setNote(null);
    try {
      await api.post("/v1/sms-settings", { organizationId: activeOrganizationId, ...s, senderId: s.senderId ?? "" }, { idempotencyKey: newIdempotencyKey() });
      await queryClient.invalidateQueries({ queryKey: ["sms-settings"] }); setDraft(null);
      setNote({ ok: true, text: "Saved." });
    } catch (cause) { setNote({ ok: false, text: message(cause, "Could not save. Nothing changed.") }); }
  }
  async function addOnCall() {
    setNote(null);
    try { await api.post("/v1/sms-oncall", { organizationId: activeOrganizationId, action: "add", label: nc.label, phone: nc.phone }, { idempotencyKey: newIdempotencyKey() }); setNc({ label: "", phone: "" }); await queryClient.invalidateQueries({ queryKey: ["sms-oncall"] }); }
    catch (cause) { setNote({ ok: false, text: message(cause, "Could not add the number.") }); }
  }
  async function removeOnCall(id: string) {
    try { await api.post("/v1/sms-oncall", { organizationId: activeOrganizationId, action: "remove", id }); await queryClient.invalidateQueries({ queryKey: ["sms-oncall"] }); }
    catch (cause) { setNote({ ok: false, text: message(cause, "Could not remove the number.") }); }
  }
  const num = (key: keyof SmsSettings, label: string, min: number, max: number) => (
    <label className="text-sm">{label}<input className={inputClass} type="number" min={min} max={max} value={Number(s[key])} disabled={!isOwner} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<SmsSettings>)} data-testid={`sms-${String(key)}`} /></label>
  );
  const flag = (key: keyof SmsSettings, label: string) => (
    <label className={checkClass}><input type="checkbox" checked={Boolean(s[key])} disabled={!isOwner} onChange={(e) => set({ [key]: e.target.checked } as Partial<SmsSettings>)} data-testid={`sms-${String(key)}`} /> {label}</label>
  );
  return (
    <Card>
      <h2 className="text-base font-semibold text-og-ink">Text messages (test sender)</h2>
      <p className="text-sm text-og-sub" data-testid="sms-mock-note">Nothing is sent to a phone yet: this agency uses the test sender, which only records what would be sent. A live sender needs setup and approval first.</p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {flag("enabled", "Turn on automatic texts for this agency")}
        <label className="text-sm">Name shown at the start of each text<input className={inputClass} maxLength={24} value={s.senderLabel} disabled={!isOwner} onChange={(e) => set({ senderLabel: e.target.value })} data-testid="sms-senderLabel" /></label>
        <label className="text-sm">This agency's sender number (set up later)<input className={inputClass} inputMode="tel" placeholder="+19515550123" value={s.senderId ?? ""} disabled={!isOwner} onChange={(e) => set({ senderId: e.target.value || null })} data-testid="sms-senderId" /></label>
        {num("recruitmentDays", "Offer shifts this many days ahead (1 to 14)", 1, 14)}
        {num("escalationHours", "Alert the office if still unfilled after (hours)", 1, 72)}
        <label className="text-sm">Quiet hours start<input className={inputClass} type="time" value={s.quietStart} disabled={!isOwner} onChange={(e) => set({ quietStart: e.target.value })} data-testid="sms-quietStart" /></label>
        <label className="text-sm">Quiet hours end<input className={inputClass} type="time" value={s.quietEnd} disabled={!isOwner} onChange={(e) => set({ quietEnd: e.target.value })} data-testid="sms-quietEnd" /></label>
        {num("dailyLimit", "Agency limit per day", 1, 5000)}
        {num("hourlyLimit", "Agency limit per hour", 1, 1000)}
        {num("perRecipientDaily", "Limit per person per day", 1, 20)}
      </div>
      <fieldset className="mt-2"><legend className="text-sm font-medium">Which texts</legend>
        {flag("recruitOn", "Open-shift offers")}{flag("receiptOn", "Call-out receipts")}{flag("cancelOn", "Cancellation notices")}{flag("confirmOn", "Confirmation to the person chosen")}{flag("officeOn", "Call-out and escalation alerts to on-call numbers")}
      </fieldset>
      <p className="mt-1 text-xs text-og-sub">Quiet hours hold texts to caregivers until they end, except receipts and shifts starting within 12 hours. Texts sent in the last 24 hours: {s.sentToday}.</p>
      {isOwner ? <div className="mt-2 flex items-center gap-3"><Button type="button" className="min-h-11" disabled={!draft} onClick={() => void save()} data-testid="sms-save">Save text settings</Button></div> : <p className="mt-1 text-xs text-og-sub">Only the agency owner can change these.</p>}
      {note ? <p role={note.ok ? "status" : "alert"} className={`mt-1 text-sm ${note.ok ? "text-og-sub" : "text-red-700"}`}>{note.text}</p> : null}
      <h3 className="mt-3 text-sm font-semibold">On-call numbers (call-out and escalation alerts)</h3>
      <ul className="mt-1 text-sm" data-testid="sms-oncall">
        {(oncall.data ?? []).map((c) => (<li key={c.id} className="flex items-center justify-between gap-2 py-1"><span>{c.label} · ends {c.phoneLast4}{c.officeName ? ` · ${c.officeName}` : " · every office"}</span>{isOwner ? <button type="button" className="min-h-11 px-2 text-sm underline" onClick={() => void removeOnCall(c.id)}>Remove</button> : null}</li>))}
        {oncall.data && oncall.data.length === 0 ? <li className="text-og-sub">No on-call numbers yet. Only the owner's in-app alerts will go out.</li> : null}
      </ul>
      {isOwner ? (
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <label className="text-sm">Label<input className={inputClass} value={nc.label} maxLength={40} onChange={(e) => setNc({ ...nc, label: e.target.value })} data-testid="oncall-label" /></label>
          <label className="text-sm">Mobile number<input className={inputClass} inputMode="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} data-testid="oncall-phone" /></label>
          <Button type="button" variant="secondary" className="min-h-11" disabled={!nc.label.trim() || nc.phone.trim().length < 7} onClick={() => void addOnCall()} data-testid="oncall-add">Add on-call number</Button>
        </div>
      ) : null}
      <h3 className="mt-3 text-sm font-semibold">Recent texts</h3>
      {history.data && history.data.length === 0 ? <p className="text-sm text-og-sub" data-testid="sms-history-empty">Nothing has been queued yet.</p> : null}
      <ul className="divide-y divide-og-line text-sm" data-testid="sms-history">
        {(history.data ?? []).slice(0, 20).map((m) => (<li key={m.id} className="py-1">{PURPOSE[m.purpose] ?? m.purpose} · {m.recipientKind === "oncall" ? "on-call" : "caregiver"} ending {m.phoneLast4} · <span data-testid="sms-status">{STATUS[m.status] ?? m.status}</span></li>))}
      </ul>
    </Card>
  );
}
