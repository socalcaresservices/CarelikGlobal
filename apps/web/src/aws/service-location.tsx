// The client's SERVICE LOCATION (0118, behind the `serviceLocation` release switch): service address (city and ZIP, entered once), service county and coordinating office, read and saved
// together in one section with one edit flow. The saved service address is the source for the city and ZIP everywhere (client Details, the schedule, open-shift alerts). Where the switch is
// off the routes do not exist: `available` is false and the old Details / Offices controls stay as they were.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { CA_COUNTIES } from "./ca-counties";
import { useAwsApi } from "./aws-workspace";
import { useOffices } from "./offices-data";
import { OfficeAssignmentsControl, AssignmentHistory } from "./office-assignments";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base min-h-[44px] md:min-h-[36px]";
const labelClass = "block text-sm font-medium text-slate-700";

export interface ServiceLocation {
  city: string | null; zip: string | null; state: string; county: string | null;
  office: { officeId: string; name: string } | null; otherOffices: Array<{ officeId: string; name: string }>;
  missing: Array<"city" | "zip">; complete: boolean; countySuggestion: { county: string; basis: "zip_reference" | "agency_clients" } | null;
}
export const BASIS_TEXT: Record<string, string> = { zip_reference: "from the ZIP reference list", agency_clients: "from other clients with this ZIP" };
const MISSING_WORD: Record<string, string> = { city: "city", zip: "ZIP code" };

/** One read of the client's service location; `available` is false where the switch is off (the route does not exist) or the person may not manage clients. */
export function useServiceLocation(clientId: string) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({ queryKey: ["service-location", clientId], queryFn: async () => (await api.get<{ location: ServiceLocation }>(`/v1/clients/${encodeURIComponent(clientId)}/service-location`, { organizationId: activeOrganizationId })).location,
    enabled: !!activeOrganizationId && !!clientId, retry: false, staleTime: 30_000 });
  return { location: q.data ?? null, available: q.isSuccess, loading: q.isLoading };
}

/** "Winchester, CA 92596 · Riverside County · Temecula office" with whatever is missing said plainly. */
export function locationSummary(l: ServiceLocation): string {
  const address = [l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter((x) => x && x.length > 0).join(", ");
  return [l.city || l.zip ? address : "No service address", l.county ? `${l.county} County` : "County not set", l.office ? `${l.office.name} office` : "No coordinating office"].join(" · ");
}

export function ServiceLocationCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const { location, available } = useServiceLocation(clientId);
  const { offices } = useOffices();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ city: "", zip: "", county: "", officeId: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  const first = useRef<HTMLInputElement | null>(null);
  const openedFromLink = useRef(false);   // the link opens the form ONCE; closing it must not re-open it while the URL still carries ?edit=location
  const wantsEdit = params.get("edit") === "location";
  // the link from "complete the service address" opens the edit form directly; the form starts from what is saved
  useEffect(() => {
    if (available && location && wantsEdit && !editing && !openedFromLink.current) { openedFromLink.current = true; setForm({ city: location.city ?? "", zip: location.zip ?? "", county: location.county ?? "", officeId: location.office?.officeId ?? "" }); setEditing(true); }
  }, [available, location, wantsEdit, editing]);
  useEffect(() => { if (editing) first.current?.focus(); }, [editing]);
  if (!available || !location) return null;
  const l = location;
  const activeOffices = offices.filter((o) => o.isActive || o.officeId === l.office?.officeId);
  const set = (k: keyof typeof form) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  function open() { setForm({ city: l.city ?? "", zip: l.zip ?? "", county: l.county ?? "", officeId: l.office?.officeId ?? "" }); setEditing(true); setState({ busy: false, error: null, done: false }); }
  function close() { setEditing(false); if (wantsEdit) { const next = new URLSearchParams(params); next.delete("edit"); setParams(next, { replace: true }); } }
  async function save() {
    if (!form.city.trim()) return setState({ busy: false, error: "Enter the city of the service address.", done: false });
    if (!/^[0-9]{5}$/.test(form.zip.trim())) return setState({ busy: false, error: "Enter the 5-digit ZIP code of the service address.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(clientId)}/service-location`, { organizationId: activeOrganizationId, city: form.city.trim(), zip: form.zip.trim(), county: form.county || null, officeId: form.officeId || null }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      for (const k of ["service-location", "aws-clients", "aws-client-directory", "aws-client-zip", "people-facets", "client-offices", "assignment-history", "offices", "shifts", "aws-shifts"]) await queryClient.invalidateQueries({ queryKey: [k] });
      close();
      setState({ busy: false, error: null, done: true });
    } catch (cause) { setState({ busy: false, error: message(cause, "Not saved. Nothing changed."), done: false }); }
  }
  const suggestion = l.countySuggestion && !form.county ? l.countySuggestion : null;
  return (
    <Card className="p-3" id="service-location" data-testid="service-location">
      <h2 className="text-base font-semibold text-slate-950">Service location</h2>
      {!editing ? (
        <>
          <p className="mt-1 text-base font-medium text-slate-950" data-testid="location-summary">{locationSummary(l)}</p>
          {!l.complete ? (
            <p role="alert" className="mt-1 text-sm text-red-800" data-testid="location-missing">
              The service address is missing the {l.missing.map((m) => MISSING_WORD[m]).join(" and ")}. Open shifts for this client cannot be sent to caregivers until it is complete.
            </p>
          ) : null}
          <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs font-medium text-slate-600">Service address</dt><dd>{l.city || l.zip ? `${l.city ?? "—"}, ${l.state} ${l.zip ?? "—"}` : "—"}</dd><dd className="text-xs text-slate-600">Where the caregiver goes. Open-shift matching uses this city.</dd></div>
            <div><dt className="text-xs font-medium text-slate-600">Service county</dt><dd>{l.county ? `${l.county} County` : "Not set"}</dd><dd className="text-xs text-slate-600">Used for county reports and filters.</dd></div>
            <div><dt className="text-xs font-medium text-slate-600">Coordinating office</dt><dd>{l.office ? l.office.name : "Not set"}</dd><dd className="text-xs text-slate-600">Manages this client&apos;s shifts and coverage requests.{l.otherOffices.length ? ` Also assigned: ${l.otherOffices.map((o) => o.name).join(", ")}.` : ""}</dd></div>
          </dl>
          <Button type="button" variant={l.complete ? "secondary" : "primary"} className="mt-2 min-h-11" onClick={open} data-testid="location-edit">{l.complete ? "Edit service location" : "Complete the service address"}</Button>
          {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">Saved. The change is in the client&apos;s history.</p> : null}
          <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-slate-700">All assigned offices and history</summary>
            <div className="mt-2 space-y-2"><OfficeAssignmentsControl kind="client" subjectId={clientId} /><AssignmentHistory kind="client" subjectId={clientId} /></div>
          </details>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 grid gap-3 sm:grid-cols-2" data-testid="location-form">
          <div><label htmlFor="loc-city" className={labelClass}>City of the service address</label><input id="loc-city" ref={first} value={form.city} maxLength={80} autoComplete="off" onChange={(e) => set("city")(e.target.value)} className={inputClass} /></div>
          <div><label htmlFor="loc-zip" className={labelClass}>ZIP code</label><input id="loc-zip" value={form.zip} maxLength={5} inputMode="numeric" autoComplete="off" onChange={(e) => set("zip")(e.target.value)} className={inputClass} /></div>
          <div>
            <label htmlFor="loc-county" className={labelClass}>Service county</label>
            <select id="loc-county" value={form.county} onChange={(e) => set("county")(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {CA_COUNTIES.map((c) => <option key={c} value={c}>{c} County</option>)}
            </select>
            {suggestion ? (
              <p className="mt-1 text-sm text-slate-700" data-testid="county-suggestion">Suggested: <strong>{suggestion.county} County</strong> ({BASIS_TEXT[suggestion.basis]}). <button type="button" className="min-h-11 px-1 underline" onClick={() => set("county")(suggestion.county)}>Use this</button></p>
            ) : null}
          </div>
          <div>
            <label htmlFor="loc-office" className={labelClass}>Coordinating office</label>
            <select id="loc-office" value={form.officeId} onChange={(e) => set("officeId")(e.target.value)} className={inputClass} disabled={activeOffices.length === 0}>
              {!l.office ? <option value="">{activeOffices.length === 0 ? "No offices yet" : "Choose an office"}</option> : null}
              {activeOffices.map((o) => <option key={o.officeId} value={o.officeId}>{o.name}{o.isActive ? "" : " (retired)"}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-600">The office is always your choice; nothing is picked for you.</p>
          </div>
          {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" className="min-h-11" disabled={state.busy}>{state.busy ? "Saving…" : "Save service location"}</Button><Button type="button" variant="secondary" className="min-h-11" disabled={state.busy} onClick={close}>Cancel</Button></div>
        </form>
      )}
    </Card>
  );
}
