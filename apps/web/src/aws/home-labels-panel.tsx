// Home labels (0124): a client's service address, its NFC/QR sticker, and the agency's label inventory. Stickers carry an opaque link and a printed ID only: no client name, no address.
// Everything here appears only where the homeLabels switch is on (the settings request succeeded) and for staff who may manage clients.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { classifyLabelInput, LABEL_ID_EXAMPLE, labelUrl, nfcSupported, qrScanSupported, readNfcLink, scanQrLink, useHomeLabelsAvailable, type AddressEvent, type LabelRow, type ServiceLocation } from "./home-labels-data";

const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base";
const fail = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "Could not save. Check your connection and try again.");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "");

type Layout = "discreet" | "agency" | "large";
const LAYOUTS: Array<[Layout, string]> = [["discreet", "Discreet (Ogevia)"], ["agency", "Agency name and color"], ["large", "Large, high contrast"]];

/** What is printed: the QR code, the sticker ID and a plain instruction. Never a name or an address. */
export function LabelSheet({ token, code, layout, agencyName, accent }: { token: string; code: string; layout: Layout; agencyName?: string | undefined; accent?: string | null }) {
  const big = layout === "large";
  const color = layout === "agency" && accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#000000";
  return (
    <div data-testid="label-sheet" className="label-print inline-block bg-white p-4 text-black" style={{ border: `${big ? 6 : 3}px solid ${color}`, borderRadius: 12 }}>
      <p style={{ fontWeight: 700, fontSize: big ? 28 : 16, color }}>{layout === "agency" && agencyName ? agencyName : "Ogevia"}</p>
      <QRCodeSVG value={labelUrl(token)} size={big ? 300 : 180} marginSize={4} level="M" fgColor="#000000" bgColor="#ffffff" />
      <p style={{ fontSize: big ? 24 : 14, fontWeight: 600 }}>Tap your phone here, or scan, to clock in or out</p>
      <p style={{ fontSize: big ? 22 : 13, letterSpacing: 1 }}>{code}</p>
    </div>
  );
}

function printNode(node: HTMLElement | null) {
  if (!node) return false;
  const page = window.open("about:blank", "_blank");
  if (!page) return false;
  page.opener = null;
  page.document.title = "Ogevia label";
  const style = page.document.createElement("style");
  style.textContent = "@page { margin: 0.5in; } body { font-family: sans-serif; } svg { display: block; margin: 8px 0; }";
  page.document.head.append(style);
  page.document.body.append(page.document.importNode(node, true));
  page.focus(); page.print();
  return true;
}

/** Preview / print / copy link for tag programming / replace / disable for ONE label. The link is fetched only when asked for, and each view is recorded by the server. */
export function LabelActions({ label, onChanged }: { label: LabelRow; onChanged: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const [token, setToken] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("discreet");
  const [mode, setMode] = useState<null | "replace" | "disable" | "history">(null);
  const [text, setText] = useState(""); const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const run = useMutation({
    mutationFn: async (task: () => Promise<void>) => task(),
    onSuccess: () => { setMode(null); setText(""); setCode(""); onChanged(); },
    onError: (cause) => setNote(fail(cause)),
  });
  const history = useQuery({ queryKey: ["label-history", label.labelId], enabled: mode === "history", retry: false,
    queryFn: async () => (await api.get<{ history: Array<{ occurredAt: string; action: string; actorName: string | null; reason: string | null }> }>(`/v1/home-labels/${label.labelId}/history`, { organizationId: activeOrganizationId })).history });
  const live = label.status === "active" || label.status === "unassigned";
  const open = async () => { setNote(null); try { setToken((await api.post<{ token: string }>(`/v1/home-labels/${label.labelId}/link`, { organizationId: activeOrganizationId })).token); } catch (cause) { setNote(fail(cause)); } };
  const accent = (activeOrganization as { accentColor?: string | null } | null | undefined)?.accentColor ?? null;
  return (
    <div className="mt-2 space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        {live ? <Button type="button" onClick={() => void open()}>Preview or print</Button> : null}
        {live ? <Button type="button" onClick={async () => { await open(); }}>Copy link for tag programming</Button> : null}
        {label.status === "active" ? <Button type="button" onClick={() => setMode("replace")}>Replace</Button> : null}
        {live ? <Button type="button" onClick={() => setMode("disable")}>Turn off</Button> : null}
        <Button type="button" onClick={() => setMode(mode === "history" ? null : "history")}>History</Button>
      </div>
      {token && live ? <div>
        <div className="flex flex-wrap items-center gap-2">
          <label>Layout <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)} className="rounded border border-slate-300 px-2 py-1">{LAYOUTS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          <Button type="button" onClick={() => { if (!printNode(sheet.current)) setNote("Allow pop-ups to print the label."); }}>Print</Button>
          <Button type="button" onClick={() => { void navigator.clipboard?.writeText(labelUrl(token)).then(() => setNote("Link copied. Write it to the NFC tag, then clear your clipboard.")).catch(() => setNote("Copy is not available on this device.")); }}>Copy link</Button>
          <Button type="button" onClick={() => setToken(null)}>Close</Button>
        </div>
        <div ref={sheet} className="mt-2"><LabelSheet token={token} code={label.labelCode} layout={layout} agencyName={activeOrganization?.displayName} accent={accent} /></div>
      </div> : null}
      {mode === "replace" ? <div className="space-y-2 rounded-xl bg-slate-50 p-3">
        <p>The new sticker takes this location and this sticker stops working at once.</p>
        <label className="block">New sticker ID<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={input} placeholder="OGL-XXXXXXXX" /></label>
        <label className="block">Reason<input value={text} onChange={(e) => setText(e.target.value)} className={input} /></label>
        <Button type="button" disabled={run.isPending || code.length < 12 || text.trim().length < 3}
          onClick={() => run.mutate(async () => { await api.post(`/v1/home-labels/${label.labelId}/replace`, { organizationId: activeOrganizationId, newLabelCode: code, reason: text.trim() }); })}>Replace sticker</Button>
      </div> : null}
      {mode === "disable" ? <div className="space-y-2 rounded-xl bg-slate-50 p-3">
        <p>This sticker will stop working. Past visits keep their record of it.</p>
        <label className="block">Reason<input value={text} onChange={(e) => setText(e.target.value)} className={input} /></label>
        <Button type="button" disabled={run.isPending || text.trim().length < 3}
          onClick={() => run.mutate(async () => { await api.post(`/v1/home-labels/${label.labelId}/deactivate`, { organizationId: activeOrganizationId, reason: text.trim() }); })}>Turn off sticker</Button>
      </div> : null}
      {mode === "history" ? <ul className="list-disc pl-5">{(history.data ?? []).map((h, i) => <li key={i}>{day(h.occurredAt)} · {h.action.replace(/_/g, " ")}{h.actorName ? ` · ${h.actorName}` : ""}{h.reason ? ` · ${h.reason}` : ""}</li>)}{history.isPending ? <li>Loading…</li> : null}</ul> : null}
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
}

/** A client's service locations and stickers (client record). */
export function HomeLabelsPanel({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const cache = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("clients.manage") && hasPermission("clients.names.manage");
  const { available } = useHomeLabelsAvailable(canManage);
  const key = ["service-locations", activeOrganizationId, clientId];
  // 0126: with the serviceAddresses switch on, the list carries every address in every state. Where it is off (404) the earlier list of current addresses is used and the new controls stay hidden.
  const list = useQuery({ queryKey: key, enabled: available && canManage, retry: false,
    queryFn: async () => {
      try { return (await api.get<{ addresses: ServiceLocation[] }>(`/v1/clients/${clientId}/service-addresses`, { organizationId: activeOrganizationId })).addresses; }
      catch (cause) {
        if ((cause as { status?: number }).status !== 404) throw cause;
        return (await api.get<{ locations: ServiceLocation[] }>(`/v1/clients/${clientId}/service-locations`, { organizationId: activeOrganizationId })).locations;
      }
    } });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "Client home", street: "", city: "", zip: "", latitude: "", longitude: "" });
  const [note, setNote] = useState<string | null>(null);
  if (!canManage || !available) return null;
  const refresh = () => { void cache.invalidateQueries({ queryKey: key }); void cache.invalidateQueries({ queryKey: ["home-labels"] }); };
  const valid = form.street.trim().length >= 2 && form.city.trim().length >= 2 && /^\d{5}(-\d{4})?$/.test(form.zip.trim());
  async function add() {
    setNote(null);
    try {
      const lat = form.latitude.trim() === "" ? null : Number(form.latitude), lng = form.longitude.trim() === "" ? null : Number(form.longitude);
      await api.post(`/v1/clients/${clientId}/service-locations`, { organizationId: activeOrganizationId, kind: "home", name: form.name.trim() || "Client home", street: form.street.trim(), city: form.city.trim(), state: "CA", zip: form.zip.trim(),
        ...(lat !== null && lng !== null ? { latitude: lat, longitude: lng } : {}) });
      setAdding(false); setForm({ name: "Client home", street: "", city: "", zip: "", latitude: "", longitude: "" }); refresh();
    } catch (cause) { setNote(fail(cause)); }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">Service address and home label</h2>
      <p className="text-sm text-slate-600">The sticker identifies this address. The caregiver's phone supplies its location at clock-in and clock-out to compare with it.</p>
      <p className="text-sm"><Link to="/home-stickers" className="underline">Need a sticker? Register and print stickers under Home stickers</Link>, then enter its ID below.</p>
      {list.isPending ? <p>Loading…</p> : null}
      {(list.data ?? []).some((l) => l.addressState !== undefined) ? <p className="mt-2 text-sm text-slate-700" data-testid="address-rule">Only one home address is <strong>current</strong> at a time. A second address you add is kept as an <strong>alternate</strong>: give it its own sticker, then make it current when the client moves between homes.</p> : null}
      {(list.data ?? []).filter((l) => l.kind === "home").map((l) => <LocationRow key={l.locationId} location={l} clientId={clientId} onChanged={refresh} />)}
      {(list.data ?? []).some((l) => l.addressState !== undefined) ? <AddressHistory clientId={clientId} /> : null}
      {(list.data ?? []).some((l) => l.kind === "home") ? null : list.isSuccess ? <p>No service address yet.</p> : null}
      {adding ? <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3">
        <label className="block text-sm font-medium">Street address<input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} className={input} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm font-medium">City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={input} /></label>
          <label className="block text-sm font-medium">ZIP code<input inputMode="numeric" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} className={input} /></label>
        </div>
        <details><summary className="text-sm">Map position (optional)</summary>
          <p className="text-xs text-slate-600">Without a map position the address cannot be checked against a phone location and is flagged for attention.</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Latitude<input value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} className={input} inputMode="decimal" /></label>
            <label className="block text-sm">Longitude<input value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} className={input} inputMode="decimal" /></label>
          </div></details>
        <div className="flex gap-2"><Button type="button" disabled={!valid} onClick={() => void add()}>Save address</Button><Button type="button" onClick={() => setAdding(false)}>Cancel</Button></div>
      </div> : <Button type="button" className="mt-2" onClick={() => setAdding(true)}>Add service address</Button>}
      {note ? <p role="alert" className="text-sm text-red-700">{note}</p> : null}
    </Card>
  );
}

const STATE_LABEL: Record<string, string> = { current: "Current address", alternate: "Alternate (not current)", historical: "Historical (no longer used)" };
const STATE_STYLE: Record<string, string> = { current: "bg-emerald-100 text-emerald-900", alternate: "bg-amber-100 text-amber-900", historical: "bg-slate-200 text-slate-800" };

/** The controls for one address: make it current, mark it inactive (alternate or historical) with a reason, or delete it when it was entered by mistake and never used. */
function AddressControls({ location: l, onChanged }: { location: ServiceLocation; onChanged: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [mode, setMode] = useState<null | "inactive" | "delete">(null);
  const [kind, setKind] = useState<"alternate" | "historical">("alternate");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true); setNote(null);
    try { await api.post(path, { organizationId: activeOrganizationId, ...body }); setMode(null); setReason(""); onChanged(); } catch (cause) { setNote(fail(cause)); } finally { setBusy(false); }
  }
  const cur = l.addressState === "current";
  return (
    <div className="mt-2 space-y-2 text-sm" data-testid="address-controls">
      <div className="flex flex-wrap gap-2">
        {!cur ? <Button type="button" disabled={busy} onClick={() => void send(`/v1/service-locations/${l.locationId}/state`, { state: "active" })}>{l.addressState === "historical" ? "Use this address again" : "Make this the current address"}</Button> : null}
        {cur || l.addressState === "alternate" ? <Button type="button" onClick={() => { setMode(mode === "inactive" ? null : "inactive"); setKind(cur ? "alternate" : "historical"); }}>{cur ? "Mark inactive…" : "Mark historical…"}</Button> : null}
        {l.canDelete ? <Button type="button" onClick={() => setMode(mode === "delete" ? null : "delete")}>Delete (entered by mistake)…</Button> : null}
      </div>
      {mode === "inactive" ? <div className="space-y-2 rounded-xl bg-slate-50 p-3">
        {cur ? <fieldset><legend className="font-medium">This address is…</legend>
          <label className="flex items-start gap-2"><input type="radio" name={`k-${l.locationId}`} checked={kind === "alternate"} onChange={() => setKind("alternate")} className="mt-1 h-5 w-5" /><span><strong>Alternate</strong>: the client also lives here at times. It is kept, with its sticker, and can be made current again.</span></label>
          <label className="flex items-start gap-2"><input type="radio" name={`k-${l.locationId}`} checked={kind === "historical"} onChange={() => setKind("historical")} className="mt-1 h-5 w-5" /><span><strong>Historical</strong>: no longer used. Its sticker is turned off. The record is kept.</span></label></fieldset> : null}
        {cur ? <p className="text-xs text-amber-900">The client will have no current address until you make another one current. Clock-in by sticker is refused meanwhile.</p> : <p className="text-xs">Its sticker is turned off. The record is kept.</p>}
        <label className="block font-medium">Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} className={input} maxLength={300} /></label>
        <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void send(`/v1/service-locations/${l.locationId}/state`, { state: cur ? kind : "historical", reason: reason.trim() })}>Save</Button>
      </div> : null}
      {mode === "delete" ? <div className="space-y-2 rounded-xl bg-slate-50 p-3">
        <p>This removes the address and its entry from the history. It is only possible because this address never had a sticker. Otherwise mark it historical.</p>
        <label className="block font-medium">Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} className={input} maxLength={300} placeholder="Typed the wrong street" /></label>
        <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void send(`/v1/service-locations/${l.locationId}/delete`, { reason: reason.trim() })}>Delete this address</Button>
      </div> : null}
      {note ? <p role="alert" className="text-red-700">{note}</p> : null}
    </div>
  );
}

const ACTION_TEXT: Record<string, string> = { created: "Address added", updated: "Address edited", activated: "Made the current address", made_alternate: "Made an alternate", made_historical: "Made historical", deleted: "Address deleted" };
function AddressHistory({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [open, setOpen] = useState(false);
  const h = useQuery({ queryKey: ["service-address-history", activeOrganizationId, clientId], enabled: open, retry: false,
    queryFn: async () => (await api.get<{ history: AddressEvent[] }>(`/v1/clients/${clientId}/service-addresses/history`, { organizationId: activeOrganizationId })).history });
  return (
    <div className="mt-3">
      <button type="button" className="text-sm underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide address history" : "Show address history"}</button>
      {open ? <ul className="mt-2 space-y-1 text-sm" data-testid="address-history">
        {h.isPending ? <li>Loading…</li> : null}
        {h.isError ? <li role="alert">The history could not be loaded.</li> : null}
        {(h.data ?? []).map((e, i) => <li key={i} className="rounded-lg border border-slate-200 p-2">
          <span className="font-medium">{ACTION_TEXT[e.action] ?? e.action}</span> · {new Date(e.occurredAt).toLocaleDateString()}{e.actorName ? ` · ${e.actorName}` : ""}
          {e.details?.city && !e.details.scrubbed ? <span> · {e.details.city} {e.details.zip}</span> : null}
          {e.details?.before?.street ? <span> · was {e.details.before.street}, {e.details.before.city} {e.details.before.zip}</span> : null}
          {e.reason ? <span className="block text-slate-700">Reason: {e.reason}</span> : null}
        </li>)}
        {h.isSuccess && h.data.length === 0 ? <li>No history yet.</li> : null}
      </ul> : null}
    </div>
  );
}

function LocationRow({ location: l, clientId, onChanged }: { location: ServiceLocation; clientId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  void clientId;
  const state = l.addressState;
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3" data-testid="location-row" data-state={state ?? "legacy"}>
      <p className="font-semibold">{l.name}{state ? <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[state] ?? ""}`}>{STATE_LABEL[state] ?? state}</span> : null}</p>
      <p className="text-sm">{l.street}, {l.city}, {l.state} {l.zip}</p>
      {state && state !== "current" && l.inactiveReason ? <p className="text-sm text-slate-700">{l.inactiveReason}{l.inactiveAt ? ` · ${day(l.inactiveAt)}` : ""}</p> : null}
      {l.needsAttention && state !== "historical" ? <p role="status" className="text-sm text-amber-800">This address has not been located on a map, so phone locations cannot be checked against it yet.</p> : null}
      {l.labelId && l.labelCode
        ? <><p className="mt-1 text-sm" data-testid="label-line">Sticker {l.labelCode} · active{l.labelInstalledAt ? ` since ${day(l.labelInstalledAt)}` : ""}</p>
          {state === "alternate" ? <p className="text-sm text-amber-900">This sticker only works when this address is the current one. Until then clock-in with it is refused.</p> : null}
          <LabelActions label={{ labelId: l.labelId, labelCode: l.labelCode, status: "active", clientCode: null, locationName: l.name, locationCity: l.city, installedAt: l.labelInstalledAt, endedAt: null, replacedByCode: null, lastUsedAt: null, createdAt: "", locationNeedsAttention: null }} onChanged={onChanged} /></>
        : state === "historical" ? <p className="mt-1 text-sm text-slate-700">No sticker. Make the address current again to give it one.</p>
        : <>{open ? <AssignLabel locationId={l.locationId} street={`${l.street}, ${l.city} ${l.zip}`} onDone={() => { setOpen(false); onChanged(); }} /> : <Button type="button" className="mt-2" onClick={() => setOpen(true)}>Assign a sticker</Button>}</>}
      {state ? <AddressControls location={l} onChanged={onChanged} /> : null}
    </div>
  );
}

/** Tap the NFC sticker, scan its QR code, or type its ID; then confirm the address on file. */
export function AssignLabel({ locationId, street, onDone }: { locationId: string; street: string; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const parsed = classifyLabelInput(value);
  async function resolveCode(): Promise<string> {
    if (parsed.kind === "code") return parsed.code;
    const r = await api.post<{ label: { labelCode: string } }>("/v1/home-labels/resolve", { organizationId: activeOrganizationId, link: value.trim() });
    if (!r.label?.labelCode) throw new Error("This sticker is not registered for your agency. Register it first under Operations → Home stickers.");
    return r.label.labelCode;
  }
  async function capture(read: (s: AbortSignal) => Promise<string | null>) {
    abort.current?.abort(); abort.current = new AbortController();
    setNote("Hold the sticker to the phone…");
    try { const link = await read(abort.current.signal); if (link) { setValue(link); setNote("Sticker read. Check the address and assign."); } else setNote("Nothing was read. Type the sticker ID instead."); }
    catch { setNote("This phone could not read the sticker. Type the sticker ID instead."); }
  }
  async function assign() {
    setBusy(true); setNote(null);
    try {
      const labelCode = await resolveCode();
      await api.post("/v1/home-labels/assign", { organizationId: activeOrganizationId, labelCode, serviceLocationId: locationId, confirmedAddress: true });
      onDone();
    } catch (cause) { setNote(fail(cause)); } finally { setBusy(false); }
  }
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-slate-50 p-3">
      <label className="block text-sm font-medium">Sticker ID or sticker link
        <input value={value} onChange={(e) => setValue(e.target.value)} className={input} placeholder={LABEL_ID_EXAMPLE} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="sticker-help sticker-check" />
      </label>
      <div id="sticker-help" className="space-y-1 text-xs text-slate-600">
        <p>Enter <strong>either</strong>:</p>
        <ul className="list-disc pl-5">
          <li>the <strong>printed sticker ID</strong>: OGL- and 8 letters or digits, like <span className="font-mono">{LABEL_ID_EXAMPLE}</span> (never I, O, 0 or 1); or</li>
          <li>the <strong>sticker link</strong> that the tag and QR code hold: it starts with https:// and ends with # and a long code. Use the buttons below to read it from the sticker.</li>
        </ul>
        <p>The phone chip's own serial number does not work. The sticker must already be registered under Operations → Home stickers.</p>
      </div>
      <p id="sticker-check" role="status" className={"text-sm " + (parsed.kind === "invalid" ? "text-red-700" : "text-emerald-700")}>
        {parsed.kind === "invalid" ? parsed.message : parsed.kind === "code" ? `Sticker ID ${parsed.code} looks right.` : parsed.kind === "link" ? "Sticker link looks right." : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {nfcSupported() ? <Button type="button" onClick={() => void capture(readNfcLink)}>Tap sticker (NFC)</Button> : null}
        {qrScanSupported() ? <Button type="button" onClick={() => void capture(scanQrLink)}>Scan QR code</Button> : null}
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 h-5 w-5" /><span>The address on file is {street}, and the sticker is installed there.</span></label>
      <Button type="button" disabled={busy || !confirmed || (parsed.kind !== "code" && parsed.kind !== "link")} onClick={() => void assign()}>{busy ? "Saving…" : "Assign sticker"}</Button>
      {note ? <p role="status" className="text-sm">{note}</p> : null}
    </div>
  );
}

/** Agency label inventory: register a batch, send the supplier the IDs only, see every sticker. */
export function LabelInventory() {
  const api = useAwsApi();
  const cache = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("clients.manage");
  const [status, setStatus] = useState("");
  const [count, setCount] = useState("10");
  const [batch, setBatch] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["home-labels", activeOrganizationId, status], retry: false,
    queryFn: async () => (await api.get<{ labels: LabelRow[] }>("/v1/home-labels", { organizationId: activeOrganizationId, status: status || null })).labels });
  const [openId, setOpenId] = useState<string | null>(null);
  async function register() {
    setNote(null);
    try {
      const r = await api.post<{ codes: string[] }>("/v1/home-labels", { organizationId: activeOrganizationId, count: Number(count) }, { idempotencyKey: crypto.randomUUID() });
      setBatch(r.codes); void cache.invalidateQueries({ queryKey: ["home-labels"] });
    } catch (cause) { setNote(fail(cause)); }
  }
  const supplierFile = () => { const blob = new Blob(["Sticker ID\r\n" + (batch ?? []).join("\r\n") + "\r\n"], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ogevia-sticker-ids.csv"; a.click(); URL.revokeObjectURL(a.href); };
  return (
    <section aria-label="Home label inventory" className="space-y-3">
      {canManage ? <Card>
        <h2 className="text-lg font-semibold">Register stickers</h2>
        <ol className="mb-2 list-decimal space-y-1 pl-5 text-sm text-slate-700" data-testid="sticker-steps">
          <li><strong>Register</strong> here: choose how many. Each gets a printed ID like <span className="font-mono">OGL-7K3M9XQ2</span> and its own link.</li>
          <li><strong>Print or program</strong> each one: find it in the list below, open <em>Print, copy link or change</em>, then <em>Preview or print</em>. For an NFC tag, <em>Copy link for tag programming</em> and write that link to the tag.</li>
          <li><strong>Assign</strong> it to the home: open the client, then <em>Service address and home label</em>, and enter the sticker ID.</li>
        </ol>
        <p className="text-sm text-slate-600">Each sticker gets a unique ID and its own link. The supplier file lists IDs only: no client names or addresses.</p>
        <label className="mt-2 block text-sm font-medium">How many<input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} className={input} /></label>
        <Button type="button" className="mt-2" disabled={!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 500} onClick={() => void register()}>Register stickers</Button>
        {batch ? <p className="mt-2 text-sm" role="status">{batch.length} stickers registered. <button type="button" className="underline" onClick={supplierFile}>Download the supplier file (IDs only)</button></p> : null}
        {note ? <p role="alert" className="text-sm text-red-700">{note}</p> : null}
      </Card> : null}
      <label className="block text-sm font-medium">Show<select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
        <option value="">All stickers</option><option value="unassigned">Not assigned</option><option value="active">Active</option><option value="disabled">Turned off</option><option value="replaced">Replaced</option></select></label>
      {list.isPending ? <p>Loading…</p> : null}
      {list.isError ? <p role="alert">The inventory could not be loaded.</p> : null}
      <ul className="space-y-2">
        {(list.data ?? []).map((l) => <li key={l.labelId} className="rounded-xl border border-slate-200 p-3" data-testid="label-row">
          <p className="font-semibold">{l.labelCode} <span className="font-normal">· {l.status === "unassigned" ? "not assigned" : l.status === "disabled" ? "turned off" : l.status}</span></p>
          {l.clientCode ? <p className="text-sm">Client {l.clientCode} · {l.locationName}{l.locationCity ? `, ${l.locationCity}` : ""}{l.installedAt ? ` · installed ${day(l.installedAt)}` : ""}</p> : null}
          {l.lastUsedAt ? <p className="text-sm">Last used {day(l.lastUsedAt)}</p> : <p className="text-sm text-slate-600">Never used</p>}
          {l.replacedByCode ? <p className="text-sm">Replaced by {l.replacedByCode}</p> : null}
          {canManage ? <><button type="button" className="text-sm underline" onClick={() => setOpenId(openId === l.labelId ? null : l.labelId)}>{openId === l.labelId ? "Hide" : "Print, copy link or change"}</button>
            {openId === l.labelId ? <LabelActions label={l} onChanged={() => void cache.invalidateQueries({ queryKey: ["home-labels"] })} /> : null}</> : null}
        </li>)}
      </ul>
      {list.isSuccess && list.data.length === 0 ? <p>No stickers registered yet.</p> : null}
    </section>
  );
}
