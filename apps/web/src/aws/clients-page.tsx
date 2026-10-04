import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

interface DirectoryClient {
  clientId: string;
  clientCode: string;
  caregiverDisplayCode: string | null;
  status: string;
  legalFirstName: string | null;
  legalLastName: string | null;
}

function NameRow({ c, onSaved }: { c: DirectoryClient; onSaved: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [first, setFirst] = useState(c.legalFirstName ?? "");
  const [last, setLast] = useState(c.legalLastName ?? "");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  async function save() {
    if (!first.trim() || !last.trim()) return setState({ busy: false, error: "Enter a first and last name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/clients/${encodeURIComponent(c.clientId)}/legal-name`, { organizationId: activeOrganizationId, firstName: first.trim(), lastName: last.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setState({ busy: false, error: null, done: true });
      onSaved();
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved.", done: false });
    }
  }
  const id = `client-${c.clientId}`;
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="font-semibold text-slate-950">{c.clientCode}{c.caregiverDisplayCode ? <span className="ml-2 text-xs font-normal text-slate-500">caregivers see {c.caregiverDisplayCode}</span> : null}</p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`${id}-first`} className="block text-xs font-medium text-slate-600">First name</label>
          <input id={`${id}-first`} value={first} maxLength={80} onChange={(e) => setFirst(e.target.value)} autoComplete="off" className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor={`${id}-last`} className="block text-xs font-medium text-slate-600">Last name</label>
          <input id={`${id}-last`} value={last} maxLength={80} onChange={(e) => setLast(e.target.value)} autoComplete="off" className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        </div>
        <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : `Save name for ${c.clientCode}`}</Button>
      </form>
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-1 text-sm text-emerald-800">Saved.</p> : null}
    </li>
  );
}

/**
 * Office-only client names (0020). Caregivers never receive them; they see
 * the client code. TEST uses synthetic names only until the BAA gate.
 */
export function ClientNamesPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("clients.names.manage");
  const directory = useQuery({
    queryKey: ["aws-client-directory", activeOrganizationId],
    queryFn: async () => (await api.get<{ clients: DirectoryClient[] }>("/v1/clients/directory", { organizationId: activeOrganizationId })).clients,
    enabled: !!activeOrganizationId && canManage,
  });
  if (!canManage) return <p className="text-sm text-slate-600">You do not have access to client names.</p>;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["aws-client-directory"] });
    void queryClient.invalidateQueries({ queryKey: ["service-visit-report"] });
    void queryClient.invalidateQueries({ queryKey: ["service-visit-report-calendar"] });
  };
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-950">Clients</h1>
        <p className="mt-1 text-sm text-slate-600">
          Names are for office use: printed calendars and reports. Caregivers never see them; they see the client code.
        </p>
        <p className="mt-1 text-xs font-semibold text-amber-900">TEST environment: synthetic names only. Do not enter real client names before the security approval.</p>
      </div>
      {directory.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {directory.isError ? <p role="alert" className="text-sm text-red-700">{(directory.error as Error).message}</p> : null}
      <ul className="space-y-3">
        {(directory.data ?? []).map((c) => <NameRow key={c.clientId} c={c} onSaved={refresh} />)}
      </ul>
    </div>
  );
}
