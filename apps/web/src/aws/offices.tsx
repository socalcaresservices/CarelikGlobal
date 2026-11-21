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
import { useClientOffices, useOffices } from "./offices-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";

/** Settings > Offices (agency Administrator). */
export function OfficesPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { offices, available, loading } = useOffices();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; kind: "rename" | "retire"; text: string } | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const createKey = useRef(newIdempotencyKey());

  if (!hasPermission("organization.update")) return <p className="text-sm text-slate-600">Only the agency Administrator can manage offices.</p>;

  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ["offices"] }); await queryClient.invalidateQueries({ queryKey: ["client-offices"] }); };
  async function run(task: () => Promise<unknown>, done: string) {
    setState({ busy: true, error: null, done: null });
    try { await task(); await refresh(); setState({ busy: false, error: null, done }); }
    catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again."), done: null }); }
  }
  const add = () => {
    if (name.trim().length < 2) { setState({ busy: false, error: "Enter an office name of at least 2 characters.", done: null }); return; }
    void run(async () => {
      await api.post("/v1/offices", { organizationId: activeOrganizationId, name: name.trim() }, { idempotencyKey: createKey.current });
      createKey.current = newIdempotencyKey(); setName("");
    }, "Office added.");
  };
  const submitEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (editing.kind === "rename" && text.length < 2) { setState({ busy: false, error: "Enter an office name of at least 2 characters.", done: null }); return; }
    if (editing.kind === "retire" && text.length < 3) { setState({ busy: false, error: "A reason is required.", done: null }); return; }
    const path = editing.kind === "rename" ? `/v1/offices/${editing.id}/rename` : `/v1/offices/${editing.id}/retire`;
    const body = editing.kind === "rename" ? { organizationId: activeOrganizationId, name: text } : { organizationId: activeOrganizationId, reason: text };
    void run(async () => { await api.post(path, body); setEditing(null); }, editing.kind === "rename" ? "Office renamed." : "Office retired.");
  };

  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-xl font-semibold text-slate-950">Offices</h1>
      <HelpLine details="Each client can have one responsible office. Billing review, Reports and the client list can then be filtered by office. A retired office keeps its history and its clients but can no longer be chosen.">
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
                      <span className="ml-2 text-xs text-slate-600">{o.clientCount} {o.clientCount === 1 ? "client" : "clients"}</span>
                    </div>
                    {o.isActive ? (
                      <div className="flex gap-2">
                        <Button type="button" variant="secondary" onClick={() => setEditing({ id: o.officeId, kind: "rename", text: o.name })}>Rename</Button>
                        <Button type="button" variant="secondary" onClick={() => setEditing({ id: o.officeId, kind: "retire", text: "" })}>Retire</Button>
                      </div>
                    ) : null}
                  </div>
                  {editing?.id === o.officeId ? (
                    <form onSubmit={(e) => { e.preventDefault(); submitEdit(); }} className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="min-w-[220px] flex-1 text-sm font-medium text-slate-700">{editing.kind === "rename" ? "New name" : "Reason for retiring (required)"}
                        <input value={editing.text} maxLength={editing.kind === "rename" ? 80 : 500} onChange={(e) => setEditing({ ...editing, text: e.target.value })} className={inputClass} />
                      </label>
                      <Button type="submit" disabled={state.busy}>{editing.kind === "rename" ? "Save name" : "Retire office"}</Button>
                      <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
    </div>
  );
}

/** A client's responsible office (clients.manage). Renders nothing where offices are not available. */
export function ClientOfficeControl({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { offices, available } = useOffices();
  const { byClientId } = useClientOffices(available);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!available || !hasPermission("clients.manage")) return null;
  const current = byClientId.get(clientId) ?? "";
  async function choose(officeId: string) {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/clients/${clientId}/office`, { organizationId: activeOrganizationId, officeId: officeId || null });
      await queryClient.invalidateQueries({ queryKey: ["client-offices"] });
      await queryClient.invalidateQueries({ queryKey: ["offices"] });
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again.") }); }
  }
  return (
    <div className="text-sm">
      <label htmlFor="client-office" className="block font-medium text-slate-700">Responsible office</label>
      <select id="client-office" value={current} disabled={state.busy} onChange={(e) => void choose(e.target.value)} className="mt-1 min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-base md:min-h-[36px]">
        <option value="">No office</option>
        {offices.filter((o) => o.isActive || o.officeId === current).map((o) => <option key={o.officeId} value={o.officeId}>{o.name}{o.isActive ? "" : " (retired)"}</option>)}
      </select>
      {state.error ? <p role="alert" className="mt-1 text-red-700">{state.error}</p> : null}
    </div>
  );
}
