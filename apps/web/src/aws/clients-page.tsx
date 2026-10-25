import { useQueryClient } from "@tanstack/react-query";
import { InfoTip } from "./ui/info-tip";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { DuplicateWarning } from "./client-extras";
import { Hint } from "./hint";
import { useDuplicateClients } from "./client-data";
import { nameWithCode } from "./name-label";
import { clientName, STATUS_BADGE, STATUS_LABEL, useClients, useClientTypes, type AdminClient, type ClientStatus } from "./client-admin";
import { defaultView, filterClients, hasCurrentAuthorization, readViewPreference, sortClients, WIDE_SCREEN_QUERY, writeViewPreference, type AuthorizationFilter, type ClientSort, type ClientView } from "./client-view";
import { actionBtn } from "./ui-classes";

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
        <button type="button" className={`mt-1 ${actionBtn}`} onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "Add a type"}</button>
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
  const [draft, setDraft] = useState(false);
  const [dupConfirmed, setDupConfirmed] = useState(false);
  const dupes = useDuplicateClients(form.first, form.last);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: keyof typeof form) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!form.first.trim() || !form.last.trim()) return setState({ busy: false, error: "Enter the client's first and last name." });
    if ((dupes.data ?? []).some((m) => m.match === "same_name") && !dupConfirmed) return setState({ busy: false, error: "A client with this name already exists. Confirm it is a different person, or open the existing client." });
    if (form.label.trim() && (form.label.trim().length < 3 || form.label.trim().length > 40)) return setState({ busy: false, error: "The caregiver label must be 3 to 40 characters." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ client: { clientId: string; clientCode: string } }>("/v1/clients", {
        organizationId: activeOrganizationId, firstName: form.first.trim(), lastName: form.last.trim(),
        city: form.city.trim() || null, clientTypeId: form.type || null, caregiverLabel: form.label.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      if (draft) await api.post(`/v1/clients/${encodeURIComponent(r.client.clientId)}/stage`, { organizationId: activeOrganizationId, stage: "draft", note: null }, { idempotencyKey: newIdempotencyKey() });
      await queryClient.invalidateQueries({ queryKey: ["aws-clients"] });
      await queryClient.invalidateQueries({ queryKey: ["aws-client-directory"] });
      setState({ busy: false, error: null });
      onDone(r.client.clientId);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The client was not added.") });
    }
  }
  return (
    <Card className="p-3">
      <h2 className="text-base font-semibold text-slate-950">Add a client</h2>
      <Hint details="Ogevia gives every client a random code. Caregivers see the code (or the label below), never the name." show>Caregivers see a code or label, never the name.</Hint>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="new-first" className="block text-sm font-medium text-slate-700">First name</label><input id="new-first" value={form.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="new-last" className="block text-sm font-medium text-slate-700">Last name</label><input id="new-last" value={form.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
        <div><label htmlFor="new-city" className="block text-sm font-medium text-slate-700">City (optional)</label><input id="new-city" value={form.city} maxLength={80} autoComplete="off" onChange={(e) => set("city")(e.target.value)} className={inputClass} /></div>
        <ClientTypeField id="new-type" value={form.type} onChange={set("type")} />
        <div className="sm:col-span-2"><label htmlFor="new-label" className="block text-sm font-medium text-slate-700">Label caregivers see instead of the code (optional)</label><input id="new-label" value={form.label} maxLength={40} autoComplete="off" onChange={(e) => set("label")(e.target.value)} className={inputClass} /></div>
        <DuplicateWarning matches={dupes.data} confirmed={dupConfirmed} onConfirm={setDupConfirmed} />
        <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-700 sm:col-span-2"><input type="checkbox" className="h-5 w-5" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Save as a draft (it cannot be scheduled until you activate it)</label>
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
  const { user } = useAuth();
  const canManage = hasPermission("clients.manage") && hasPermission("clients.names.manage");
  const clients = useClients();
  const [search, setSearch] = useState("");
  // Home's Find Client action arrives as ?find=1: put the cursor in the search box.
  const [params] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (params.get("find") === "1") searchRef.current?.focus(); }, [params, clients.isSuccess]);
  const [status, setStatus] = useState<ClientStatus | "all">("active");
  const [authorization, setAuthorization] = useState<AuthorizationFilter>("all");
  const [sort, setSort] = useState<ClientSort>("name");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  // View: the signed-in person's saved choice, else List on a wide screen and Cards on a phone.
  const [view, setView] = useState<ClientView>(() => {
    const saved = readViewPreference(user?.id, safeStorage());
    return saved ?? defaultView(typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia(WIDE_SCREEN_QUERY).matches);
  });
  const userId = user?.id;
  useEffect(() => {
    // Another person signing in on this device gets their own saved choice, not the previous person's.
    const saved = readViewPreference(userId, safeStorage());
    if (saved) setView(saved);
  }, [userId]);
  const chooseView = (next: ClientView) => { setView(next); writeViewPreference(userId, next, safeStorage()); };
  const shown = useMemo(() => sortClients(filterClients(clients.data ?? [], { search, status, authorization }), sort), [clients.data, search, status, authorization, sort]);
  if (!hasPermission("clients.names.read")) return <p className="text-sm text-slate-600">You do not have access to client records.</p>;
  const counts = (clients.data ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-1.5"><h1 className="text-xl font-bold tracking-tight text-og-ink">Clients</h1><InfoTip label="About Clients" title="Clients">Manage client profiles and care information.</InfoTip></div>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add client"}</Button> : null}
      </div>
      {adding ? <AddClientForm onDone={(id) => { setAdding(false); setAdded(id); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Client added. <Link className="underline" to={`/clients/${added}`}>Add authorized hours</Link>.</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="client-search" className="block text-sm font-medium text-slate-700">Search</label>
          <input id="client-search" ref={searchRef} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, city or type" className={inputClass} />
        </div>
        <div>
          <label htmlFor="client-status" className="block text-sm font-medium text-slate-700">Status</label>
          <select id="client-status" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus | "all")} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            {(["active", "inactive", "discharged"] as const).map((st) => <option key={st} value={st}>{STATUS_LABEL[st]} ({counts[st] ?? 0})</option>)}
            <option value="all">All ({clients.data?.length ?? 0})</option>
          </select>
        </div>
        <div>
          <label htmlFor="client-authorization" className="block text-sm font-medium text-slate-700">Authorization</label>
          <select id="client-authorization" value={authorization} onChange={(e) => setAuthorization(e.target.value as AuthorizationFilter)} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="all">All</option>
            <option value="current">Current</option>
            <option value="none">None current</option>
          </select>
        </div>
        <div>
          <label htmlFor="client-sort" className="block text-sm font-medium text-slate-700">Sort by</label>
          <select id="client-sort" value={sort} onChange={(e) => setSort(e.target.value as ClientSort)} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="name">Name</option>
            <option value="status">Status</option>
            <option value="authorization">Authorization (none first)</option>
          </select>
        </div>
        <div role="group" aria-label="View" className="inline-flex overflow-hidden rounded-lg border border-slate-300">
          {(["list", "cards"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => chooseView(v)}
              className={`min-h-[44px] px-4 text-sm font-semibold ${view === v ? "bg-og-accent text-og-on-accent" : "bg-og-card text-slate-800"}`}>{v === "list" ? "List" : "Cards"}</button>
          ))}
        </div>
      </div>
      {clients.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {clients.isError ? <p role="alert" className="text-sm text-red-700">{(clients.error as Error).message}</p> : null}
      {clients.data && shown.length === 0 ? <p className="text-sm text-slate-600">No clients match.</p> : null}
      {view === "list" ? (
        shown.length > 0 ? <ClientList clients={shown} /> : null
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Clients as cards">
          {shown.map((c) => <ClientCard key={c.clientId} c={c} />)}
        </ul>
      )}
    </div>
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const authLabel = (c: AdminClient) => (hasCurrentAuthorization(c) ? `${c.currentAuthorizations} current authorization${c.currentAuthorizations === 1 ? "" : "s"}` : "None current");
const actionLabel = (c: AdminClient) => (hasCurrentAuthorization(c) ? "View authorized hours →" : "Add authorized hours →");

/** Compact rows: client, status, authorization, one action. The same rows and permissions as Cards. */
function ClientList({ clients }: { clients: AdminClient[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-og-card">
      <table className="w-full text-left text-sm" aria-label="Clients as a list">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
            <th scope="col" className="w-10 px-3 py-1.5 text-right font-semibold">No.</th>
            <th scope="col" className="px-3 py-1.5 font-semibold">Client</th>
            <th scope="col" className="px-3 py-1.5 font-semibold">Status</th>
            <th scope="col" className="px-3 py-1.5 font-semibold">Authorization</th>
            <th scope="col" className="px-3 py-1.5 font-semibold"><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c, i) => (
            <tr key={c.clientId} className="border-b border-slate-100 last:border-0">
              <td className="w-10 px-3 py-1 text-right tabular-nums text-slate-600" data-testid="row-no">{i + 1}</td>
              <th scope="row" className="px-3 py-1 font-medium text-slate-950">
                {nameWithCode(clientName(c), c.clientCode, c.duplicateName)}
                {c.openVisits > 0 ? <span className="ml-2 text-xs font-normal text-slate-600">visit in progress</span> : null}
              </th>
              <td className="px-3 py-1"><span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span></td>
              <td className={`px-3 py-1 ${!hasCurrentAuthorization(c) && c.status === "active" ? "font-semibold text-red-700" : "text-slate-800"}`}>{authLabel(c)}</td>
              <td className="px-3 py-1"><Link to={`/clients/${c.clientId}`} className="inline-flex min-h-[44px] items-center font-medium text-og-link underline md:min-h-[32px]" aria-label={`${actionLabel(c)} for ${clientName(c) ?? c.clientCode}`}>{actionLabel(c)}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phone and Cards view: a compact expandable row; the key line and status show, details and the one action open on tap. */
function ClientCard({ c }: { c: AdminClient }) {
  const name = clientName(c);
  const missing = !hasCurrentAuthorization(c) && c.status === "active";
  return (
    <li className="rounded-xl border border-slate-200 bg-og-card">
      <details>
        <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 font-semibold text-slate-950">{nameWithCode(name, c.clientCode, c.duplicateName)}</span>
          <span className="flex items-center gap-2">
            {missing ? <span className="text-xs font-semibold text-red-700">No authorization</span> : null}
            <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
          </span>
        </summary>
        <div className="space-y-1 border-t border-slate-100 px-3 py-2 text-sm">
          <p className="text-slate-700">
            {[`Code ${c.clientCode}`, c.city, c.clientTypeName, c.caregiverDisplayCode ? `caregivers see "${c.caregiverDisplayCode}"` : null].filter(Boolean).join(" · ") || "No city or type"}
          </p>
          <p className={missing ? "font-semibold text-red-700" : "text-slate-700"}>
            Authorization: {authLabel(c)}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
          </p>
          <Link to={`/clients/${c.clientId}`} className="inline-flex min-h-[44px] items-center font-medium text-og-link underline">{actionLabel(c)}</Link>
        </div>
      </details>
    </li>
  );
}
