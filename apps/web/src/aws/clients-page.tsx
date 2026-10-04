import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { clientName, STATUS_BADGE, STATUS_LABEL, useClients, useClientTypes, type AdminClient, type ClientStatus } from "./client-admin";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";

/** Client type select with an inline "add a type" for people who manage clients. */
export function ClientTypeField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const types = useClientTypes();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  async function add() {
    if (!name.trim()) return setError("Enter a type name.");
    try {
      const r = await api.post<{ clientTypeId: string }>("/v1/client-types", { organizationId: activeOrganizationId, name: name.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-client-types"] });
      onChange(r.clientTypeId);
      setAdding(false);
      setName("");
      setError(null);
    } catch (cause) {
      setError(message(cause, "The type was not added."));
    }
  }
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">Client type (optional)</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
          <option value="">No type</option>
          {(types.data ?? []).filter((t) => t.isActive || t.clientTypeId === value).map((t) => <option key={t.clientTypeId} value={t.clientTypeId}>{t.name}</option>)}
        </select>
        <button type="button" className="mt-1 text-sm font-medium text-slate-700 underline" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "Add a type"}</button>
      </div>
      {adding ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`${id}-new`} className="block text-xs font-medium text-slate-600">New type name</label>
            <input id={`${id}-new`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </div>
          <Button type="button" variant="secondary" onClick={() => void add()}>Save type</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function AddClientForm({ onDone }: { onDone: (clientId: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [form, setForm] = useState({ first: "", last: "", city: "", type: "", label: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof form) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!form.first.trim() || !form.last.trim()) return setState({ busy: false, error: "Enter the client's first and last name." });
    if (form.label.trim() && (form.label.trim().length < 3 || form.label.trim().length > 40)) return setState({ busy: false, error: "The caregiver label must be 3 to 40 characters." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ client: { clientId: string; clientCode: string } }>("/v1/clients", {
        organizationId: activeOrganizationId, firstName: form.first.trim(), lastName: form.last.trim(),
        city: form.city.trim() || null, clientTypeId: form.type || null, caregiverLabel: form.label.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-clients"] });
      await queryClient.invalidateQueries({ queryKey: ["aws-client-directory"] });
      setState({ busy: false, error: null });
      onDone(r.client.clientId);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The client was not added.") });
    }
  }
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Add a client</h2>
      <p className="mt-1 text-xs text-slate-600">Ogevia gives every client a random code. Caregivers see the code (or the label below), never the name.</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="new-first" className="block text-sm font-medium text-slate-700">First name</label><input id="new-first" value={form.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="new-last" className="block text-sm font-medium text-slate-700">Last name</label><input id="new-last" value={form.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="new-city" className="block text-sm font-medium text-slate-700">City (optional)</label><input id="new-city" value={form.city} maxLength={80} autoComplete="off" onChange={(e) => set("city")(e.target.value)} className={inputClass} /></div>
        <ClientTypeField id="new-type" value={form.type} onChange={set("type")} />
        <div className="sm:col-span-2"><label htmlFor="new-label" className="block text-sm font-medium text-slate-700">Label caregivers see instead of the code (optional)</label><input id="new-label" value={form.label} maxLength={40} autoComplete="off" onChange={(e) => set("label")(e.target.value)} className={inputClass} /></div>
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add client"}</Button></div>
      </form>
    </Card>
  );
}

/**
 * Clients (0022): Administrator and managers add clients, edit details and
 * change status; everything is audited server-side. Names and city are office
 * information; caregivers never receive them.
 */
export function ClientsPage() {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("clients.manage") && hasPermission("clients.names.manage");
  const clients = useClients();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ClientStatus | "all">("active");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (clients.data ?? []).filter((c) => (status === "all" || c.status === status)
      && (!s || [clientName(c), c.clientCode, c.caregiverDisplayCode, c.city, c.clientTypeName].some((v) => v?.toLowerCase().includes(s))));
  }, [clients.data, search, status]);
  if (!hasPermission("clients.names.read")) return <p className="text-sm text-slate-600">You do not have access to client records.</p>;
  const counts = (clients.data ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">Clients</h1>
          <p className="mt-1 text-sm text-slate-600">Client details, status and authorized hours. Caregivers only ever see the client code or label.</p>
          <p className="mt-1 text-xs font-semibold text-amber-900">TEST environment: synthetic clients only until the security approval.</p>
        </div>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add client"}</Button> : null}
      </div>
      {adding ? <AddClientForm onDone={(id) => { setAdding(false); setAdded(id); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Client added. <Link className="underline" to={`/clients/${added}`}>Open it to add authorized hours</Link>.</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="client-search" className="block text-sm font-medium text-slate-700">Search</label>
          <input id="client-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, city or type" className={inputClass} />
        </div>
        <div>
          <label htmlFor="client-status" className="block text-sm font-medium text-slate-700">Status</label>
          <select id="client-status" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus | "all")} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            {(["active", "inactive", "discharged"] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
            <option value="all">All ({clients.data?.length ?? 0})</option>
          </select>
        </div>
      </div>
      {clients.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {clients.isError ? <p role="alert" className="text-sm text-red-700">{(clients.error as Error).message}</p> : null}
      {clients.data && shown.length === 0 ? <p className="text-sm text-slate-600">No clients match.</p> : null}
      <ul className="space-y-2">
        {shown.map((c) => <ClientCard key={c.clientId} c={c} />)}
      </ul>
    </div>
  );
}

function ClientCard({ c }: { c: AdminClient }) {
  const name = clientName(c);
  return (
    <li>
      <Link to={`/clients/${c.clientId}`} className="block rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-400">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-slate-950">{name ?? "Name not set"} <span className="font-normal text-slate-500">({c.clientCode})</span></p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {[c.city, c.clientTypeName, c.caregiverDisplayCode ? `caregivers see "${c.caregiverDisplayCode}"` : null].filter(Boolean).join(" · ") || "No city or type"}
        </p>
        <p className={`mt-1 text-sm ${c.currentAuthorizations === 0 && c.status === "active" ? "font-semibold text-red-700" : "text-slate-700"}`}>
          {c.currentAuthorizations === 0 ? "No current authorization" : `${c.currentAuthorizations} current authorization${c.currentAuthorizations === 1 ? "" : "s"}`}
          {c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
        </p>
      </Link>
    </li>
  );
}
