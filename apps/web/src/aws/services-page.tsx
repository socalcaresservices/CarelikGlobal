import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useServices, type AgencyService } from "./client-admin";
import { InfoTip } from "./ui/info-tip";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm";

function useRefreshServices() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-services", "service-visit-report"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

function AddServiceForm() {
  const api = useAwsApi();
  const refresh = useRefreshServices();
  const { activeOrganizationId } = useOrganization();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(code.trim())) return setState({ busy: false, error: "The code must be 1 to 20 letters, numbers, dots, dashes or underscores.", done: false });
    if (name.trim().length < 2) return setState({ busy: false, error: "Enter the service name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post("/v1/services", { organizationId: activeOrganizationId, code: code.trim(), name: name.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setCode(""); setName("");
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The service was not added."), done: false });
    }
  }
  return (
    <Card>
      <details open={state.done || undefined}>
      <summary className="min-h-[44px] md:min-h-[32px] cursor-pointer text-base font-semibold text-slate-950">Add a service</summary>
      <p className="mt-1 text-xs text-slate-600">The code cannot be changed later. Use the code your payer uses.</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 sm:grid-cols-3">
        <div><label htmlFor="svc-code" className="block text-sm font-medium text-slate-700">Code</label><input id="svc-code" value={code} maxLength={20} autoComplete="off" onChange={(e) => { setCode(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
        <div className="sm:col-span-2"><label htmlFor="svc-name" className="block text-sm font-medium text-slate-700">Name</label><input id="svc-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-3">Service added.</p> : null}
        <div className="sm:col-span-3"><Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add service"}</Button></div>
      </form>
      </details>
    </Card>
  );
}

function ServiceRow({ s, canManage }: { s: AgencyService; canManage: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshServices();
  const { activeOrganizationId } = useOrganization();
  const [mode, setMode] = useState<"view" | "rename" | "status">("view");
  const [name, setName] = useState(s.name);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function run(path: string, body: Record<string, unknown>, done: string) {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/services/${encodeURIComponent(s.serviceId)}/${path}`, { organizationId: activeOrganizationId, ...body }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setMode("view");
      setReason("");
      setState({ busy: false, error: null, done });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: null });
    }
  }
  const id = `svc-${s.serviceId.slice(0, 8)}`;
  return (
    <li className="rounded-lg border border-slate-200 bg-og-card px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-950">{s.name} <span className="font-normal text-slate-500">({s.code})</span></p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.isActive ? "bg-emerald-100 text-emerald-900" : "bg-slate-200 text-slate-800"}`}>{s.isActive ? "Active" : "Inactive"}</span>
      </div>
      {canManage && mode === "view" ? (
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          <button type="button" className="font-medium text-slate-800 underline" onClick={() => { setMode("rename"); setName(s.name); setState({ busy: false, error: null, done: null }); }}>Rename</button>
          <button type="button" className="font-medium text-slate-800 underline" onClick={() => { setMode("status"); setState({ busy: false, error: null, done: null }); }}>{s.isActive ? "Deactivate" : "Reactivate"}</button>
        </div>
      ) : null}
      {mode === "rename" ? (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) return setState({ busy: false, error: "Enter the service name.", done: null }); void run("name", { name: name.trim() }, "Renamed."); }} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1"><label htmlFor={`${id}-name`} className="block text-xs font-medium text-slate-600">New name for {s.code}</label><input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => { setName(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
          <Button type="submit" variant="secondary" disabled={state.busy}>Save name</Button>
          <button type="button" className="text-sm underline" onClick={() => setMode("view")}>Cancel</button>
        </form>
      ) : null}
      {mode === "status" ? (
        <form onSubmit={(e) => { e.preventDefault(); if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the change.", done: null }); void run("status", { active: !s.isActive, reason: reason.trim() }, s.isActive ? "Deactivated." : "Reactivated."); }} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1"><label htmlFor={`${id}-reason`} className="block text-xs font-medium text-slate-600">Reason to {s.isActive ? "deactivate" : "reactivate"} {s.code}</label><input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
          <Button type="submit" variant="secondary" disabled={state.busy}>{s.isActive ? "Deactivate" : "Reactivate"}</Button>
          <button type="button" className="text-sm underline" onClick={() => setMode("view")}>Cancel</button>
        </form>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-1 text-sm text-emerald-800">{state.done}</p> : null}
    </li>
  );
}

/** Services (0023): the agency's own list. Administrator changes it; managers can see it. */
export function ServicesPage() {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("services.manage");
  const services = useServices();
  if (!hasPermission("authorizations.read")) return <p className="text-sm text-slate-600">You do not have access to services.</p>;
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center gap-1.5">
        <h1 className="text-xl font-bold tracking-tight text-slate-950">Services</h1>
        <InfoTip label="About Services">The services your agency provides.{canManage ? "" : " Only the agency Administrator can change this list."} Deactivating a service is refused while clients still have current authorizations for it.</InfoTip>
      </div>
      {canManage ? <AddServiceForm /> : null}
      {services.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {services.isError ? <p role="alert" className="text-sm text-red-700">{(services.error as Error).message}</p> : null}
      <ul className="space-y-1">
        {(services.data ?? []).map((s) => <ServiceRow key={s.serviceId} s={s} canManage={canManage} />)}
      </ul>
    </div>
  );
}
