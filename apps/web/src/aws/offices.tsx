// Offices (0110, behind the offices release switch): the agency's list of offices, and a client's responsible office.
// Where the switch is off the routes do not exist and the browser sees a failed request, not a clean 404, so every office control stays out of sight
// unless the list actually loaded (`available`). Nothing here changes an hour calculation or a record's status.
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { HelpLine } from "./ui/help-line";
import { CA_COUNTIES } from "./ca-counties";
import { AssignmentHistory, ClientServiceCountyControl, OfficeAssignmentsControl } from "./office-assignments";
import { useOffices } from "./offices-data";
import { InvitationLook } from "./invitation-look";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";

/** Settings > Offices (agency Administrator). */
export function OfficesPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const { offices, available, loading } = useOffices();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; kind: "edit" | "retire"; text: string; address: string; city: string; zip: string; county: string } | null>(null);
  const [draft, setDraft] = useState({ address: "", city: "", zip: "", county: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const createKey = useRef(newIdempotencyKey());

  if (!hasPermission("organization.update")) return <p className="text-sm text-slate-600">Only the agency Administrator can manage offices.</p>;

  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ["offices"] }); await queryClient.invalidateQueries({ queryKey: ["client-offices"] }); await queryClient.invalidateQueries({ queryKey: ["people-facets"] }); };
  async function run(task: () => Promise<unknown>, done: string) {
    setState({ busy: true, error: null, done: null });
    try { await task(); await refresh(); setState({ busy: false, error: null, done }); }
    catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again."), done: null }); }
  }
  const add = () => {
    if (name.trim().length < 2) { setState({ busy: false, error: "Enter an office name of at least 2 characters.", done: null }); return; }
    void run(async () => {
      const created = await api.post<{ officeId: string }>("/v1/offices", { organizationId: activeOrganizationId, name: name.trim() }, { idempotencyKey: createKey.current });
      createKey.current = newIdempotencyKey();
      // The address and county are optional at creation; they are saved on the same office record with the edit route.
      if (draft.address.trim() || draft.city.trim() || draft.zip.trim() || draft.county) {
        await api.post(`/v1/offices/${created.officeId}/update`, { organizationId: activeOrganizationId, name: name.trim(), addressLine1: draft.address.trim() || null, city: draft.city.trim() || null, postalCode: draft.zip.trim() || null, county: draft.county || null });
      }
      setName(""); setDraft({ address: "", city: "", zip: "", county: "" });
    }, "Office added.");
  };
  const submitEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (editing.kind === "edit" && text.length < 2) { setState({ busy: false, error: "Enter an office name of at least 2 characters.", done: null }); return; }
    if (editing.kind === "retire" && text.length < 3) { setState({ busy: false, error: "A reason is required.", done: null }); return; }
    const path = editing.kind === "edit" ? `/v1/offices/${editing.id}/update` : `/v1/offices/${editing.id}/retire`;
    const body = editing.kind === "edit"
      ? { organizationId: activeOrganizationId, name: text, addressLine1: editing.address.trim() || null, city: editing.city.trim() || null, postalCode: editing.zip.trim() || null, county: editing.county || null }
      : { organizationId: activeOrganizationId, reason: text };
    void run(async () => { await api.post(path, body); setEditing(null); }, editing.kind === "edit" ? "Office saved. Its clients and caregivers keep their assignments." : "Office retired.");
  };
  const reactivate = (id: string) => void run(() => api.post(`/v1/offices/${id}/reactivate`, { organizationId: activeOrganizationId }), "Office reactivated.");
  const countyField = (value: string, onChange: (v: string) => void) => (
    <label className="text-sm font-medium text-slate-700">County
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}><option value="">Not set</option>{CA_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
    </label>
  );

  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-xl font-semibold text-slate-950">Offices</h1>
      <HelpLine details="Clients and caregivers can be assigned to one or more offices (one is primary). Lists, Billing review and Reports can be filtered by office. An office's address and county describe the office only; changing them never changes anyone's assignment or service county. A retired office keeps its history and assignments but can no longer be chosen.">
        The agency&apos;s offices.
      </HelpLine>
      {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {!loading && !available ? <p role="status" className="text-sm text-slate-700">Offices are not available in this environment yet.</p> : null}
      {available ? (
        <>
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); add(); }} className="flex flex-wrap items-end gap-2">
              <label className="min-w-[220px] flex-1 text-sm font-medium text-slate-700">New office
                <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. North Office" className={inputClass} />
              </label>
              <label className="min-w-[220px] flex-1 text-sm font-medium text-slate-700">Address (optional)
                <input value={draft.address} maxLength={200} onChange={(e) => setDraft({ ...draft, address: e.target.value })} className={inputClass} />
              </label>
              <label className="min-w-[140px] text-sm font-medium text-slate-700">City
                <input value={draft.city} maxLength={80} onChange={(e) => setDraft({ ...draft, city: e.target.value })} className={inputClass} />
              </label>
              <label className="w-28 text-sm font-medium text-slate-700">ZIP
                <input value={draft.zip} maxLength={10} onChange={(e) => setDraft({ ...draft, zip: e.target.value })} className={inputClass} />
              </label>
              {countyField(draft.county, (county) => setDraft({ ...draft, county }))}
              <Button type="submit" disabled={state.busy}>Add office</Button>
            </form>
          </Card>
          {offices.length === 0 ? <p className="text-sm text-slate-600">No offices yet.</p> : (
            <ul aria-label="Offices" className="space-y-2">
              {offices.map((o) => (
                <li key={o.officeId} className="rounded-lg border border-slate-200 bg-og-card px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-medium text-slate-900">{o.name}</span>
                      {!o.isActive ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">Retired</span> : null}
                      <span className="ml-2 text-xs text-slate-600">{o.clientCount} {o.clientCount === 1 ? "client" : "clients"} · {o.caregiverCount ?? 0} {(o.caregiverCount ?? 0) === 1 ? "caregiver" : "caregivers"}</span>
                      {o.addressLine1 || o.city || o.postalCode || o.county ? <p className="text-xs text-slate-600">{[o.addressLine1, o.city, o.postalCode].filter(Boolean).join(", ")}{o.county ? ` · ${o.county} County` : ""}</p> : null}
                    </div>
                    {o.isActive ? (
                      <div className="flex gap-2">
                        <Button type="button" variant="secondary" onClick={() => setEditing({ id: o.officeId, kind: "edit", text: o.name, address: o.addressLine1 ?? "", city: o.city ?? "", zip: o.postalCode ?? "", county: o.county ?? "" })}>Edit</Button>
                        <Button type="button" variant="secondary" onClick={() => setEditing({ id: o.officeId, kind: "retire", text: "", address: "", city: "", zip: "", county: "" })}>Retire</Button>
                      </div>
                    ) : <Button type="button" variant="secondary" disabled={state.busy} onClick={() => reactivate(o.officeId)}>Reactivate</Button>}
                  </div>
                  {editing?.id === o.officeId ? (
                    <form onSubmit={(e) => { e.preventDefault(); submitEdit(); }} className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="min-w-[220px] flex-1 text-sm font-medium text-slate-700">{editing.kind === "edit" ? "Office name" : "Reason for retiring (required)"}
                        <input value={editing.text} maxLength={editing.kind === "edit" ? 80 : 500} onChange={(e) => setEditing({ ...editing, text: e.target.value })} className={inputClass} />
                      </label>
                      {editing.kind === "edit" ? (
                        <>
                          <label className="min-w-[220px] flex-1 text-sm font-medium text-slate-700">Address
                            <input value={editing.address} maxLength={200} onChange={(e) => setEditing({ ...editing, address: e.target.value })} className={inputClass} />
                          </label>
                          <label className="min-w-[140px] text-sm font-medium text-slate-700">City
                            <input value={editing.city} maxLength={80} onChange={(e) => setEditing({ ...editing, city: e.target.value })} className={inputClass} />
                          </label>
                          <label className="w-28 text-sm font-medium text-slate-700">ZIP
                            <input value={editing.zip} maxLength={10} onChange={(e) => setEditing({ ...editing, zip: e.target.value })} className={inputClass} />
                          </label>
                          {countyField(editing.county, (county) => setEditing({ ...editing, county }))}
                        </>
                      ) : null}
                      <Button type="submit" disabled={state.busy}>{editing.kind === "edit" ? "Save office" : "Retire office"}</Button>
                      <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <InvitationLook companyName={activeOrganization?.displayName ?? "Your agency"} />
        </>
      ) : null}
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
    </div>
  );
}

/** A client's Assigned Offices and Service County (clients.manage to change). Renders nothing where offices are not available. */
export function ClientOfficeControl({ clientId }: { clientId: string }) {
  return (
    <div className="space-y-3">
      <OfficeAssignmentsControl kind="client" subjectId={clientId} />
      <ClientServiceCountyControl clientId={clientId} />
      <AssignmentHistory kind="client" subjectId={clientId} />
    </div>
  );
}
