// Authorization Worklist and dashboard (0125). One list of every client service whose authorization needs attention, with authorized, used, scheduled and remaining hours for a chosen
// month; filter by client, office, program, status and date; export CSV or Excel; print. Read only: nothing here changes an authorization or an hour.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useOffices } from "./offices-data";
import { exportRows } from "./report-export";
import { hoursText, statusLabel, useWorklistAvailable, WORKLIST_COLUMNS, WORKLIST_STATUSES, type WorklistRow } from "./authorization-worklist-data";

const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base";
const TONE: Record<string, string> = { missing: "bg-red-100 text-red-900", expired: "bg-red-100 text-red-900", exhausted: "bg-red-100 text-red-900", expiring: "bg-amber-100 text-amber-900", nearly_exhausted: "bg-amber-100 text-amber-900", ok: "bg-emerald-100 text-emerald-900" };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");


export function AuthorizationWorklistPage() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("authorizations.read");
  const { available } = useWorklistAvailable(canRead);
  const { offices, available: officesOn } = useOffices(canRead);
  const [month, setMonth] = useState(""); const [status, setStatus] = useState(""); const [office, setOffice] = useState(""); const [program, setProgram] = useState("");
  const [client, setClient] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [days, setDays] = useState("30");
  const query = { organizationId: activeOrganizationId, month: month ? `${month}-01` : null, status: status || null, officeId: office || null, program: program || null, from: from || null, to: to || null, expiringDays: days || null };
  const all = useQuery({ queryKey: ["authorization-worklist", query], enabled: canRead && available && !!activeOrganizationId, retry: false, placeholderData: (previous) => previous,
    queryFn: async () => (await api.get<{ rows: WorklistRow[] }>("/v1/authorization-worklist", query)).rows });
  const rows = (all.data ?? []).filter((r) => !client || r.clientCode === client);
  // The dashboard counts the whole answer for the chosen month and filters, not just what the status chip shows.
  const base = useQuery({ queryKey: ["authorization-worklist", { ...query, status: null }], enabled: canRead && available && !!activeOrganizationId && !!status, retry: false, placeholderData: (previous) => previous,
    queryFn: async () => (await api.get<{ rows: WorklistRow[] }>("/v1/authorization-worklist", { ...query, status: null })).rows });
  const dash = useMemo(() => (status ? base.data : all.data) ?? [], [status, base.data, all.data]);
  const counts = useMemo(() => Object.fromEntries(WORKLIST_STATUSES.map(([s]) => [s, dash.filter((r) => r.status === s).length])), [dash]);
  const hours = useMemo(() => dash.reduce((t, r) => ({ a: t.a + (r.authorizedMinutes ?? 0), u: t.u + (r.usedMinutes ?? 0), s: t.s + (r.scheduledMinutes ?? 0), r: t.r + (r.remainingMinutes ?? 0) }), { a: 0, u: 0, s: 0, r: 0 }), [dash]);
  const byOffice = useMemo(() => {
    const m = new Map<string, { name: string; attention: number; total: number; remaining: number }>();
    for (const r of dash) { const k = r.officeName ?? "No office"; const e = m.get(k) ?? { name: k, attention: 0, total: 0, remaining: 0 }; e.total++; if (r.status !== "ok") e.attention++; e.remaining += r.remainingMinutes ?? 0; m.set(k, e); }
    return [...m.values()].sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name));
  }, [dash]);
  const programs = useMemo(() => [...new Set((all.data ?? []).map((r) => r.program).filter((p): p is string => !!p))].sort(), [all.data]);
  const clients = useMemo(() => [...new Set((all.data ?? []).map((r) => r.clientCode))].sort(), [all.data]);

  if (!canRead) return <p className="text-sm text-slate-600">You do not have access to authorizations.</p>;
  if (!available) return <p className="text-sm text-slate-600">The Authorization Worklist is not turned on for your agency yet.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <h1 className="text-2xl font-semibold">Authorization Worklist</h1>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => exportRows("csv", "authorization-worklist", "Authorizations", WORKLIST_COLUMNS, rows)}>Export CSV</Button>
          <Button type="button" onClick={() => exportRows("xlsx", "authorization-worklist", "Authorizations", WORKLIST_COLUMNS, rows)}>Export Excel</Button>
          <Button type="button" onClick={() => window.print()}>Print</Button>
        </div>
      </div>
      <h1 className="hidden print:block text-xl font-semibold">Authorization Worklist{month ? ` — ${month}` : ""}</h1>

      <section aria-label="Authorization dashboard" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {WORKLIST_STATUSES.map(([s, label]) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(status === s ? "" : s)} data-testid={`count-${s}`}
            className={`rounded-xl border p-3 text-left ${status === s ? "border-slate-900" : "border-slate-200"} ${TONE[s]}`}>
            <span className="block text-2xl font-semibold">{counts[s] ?? 0}</span><span className="text-sm">{label}</span>
          </button>))}
      </section>
      <section aria-label="Hours" className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="hours-summary">
        {([["Authorized", hours.a], ["Used", hours.u], ["Scheduled", hours.s], ["Remaining", hours.r]] as const).map(([l, v]) => <Card key={l}><p className="text-sm text-slate-600">{l} (hours)</p><p className="text-xl font-semibold">{hoursText(v) || "0"}</p></Card>)}
      </section>
      {officesOn && byOffice.length > 1 ? <section aria-label="By office"><h2 className="text-lg font-semibold">By office</h2>
        <table className="min-w-full text-left text-sm"><thead><tr><th className="py-1 pr-3">Office</th><th className="pr-3">Services</th><th className="pr-3">Need attention</th><th>Remaining (hours)</th></tr></thead>
          <tbody>{byOffice.map((o) => <tr key={o.name}><td className="py-1 pr-3">{o.name}</td><td className="pr-3">{o.total}</td><td className="pr-3">{o.attention}</td><td>{hoursText(o.remaining)}</td></tr>)}</tbody></table></section> : null}

      <section aria-label="Filters" className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4 print:hidden">
        <label className="text-sm font-medium">Month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={input} /></label>
        <label className="text-sm font-medium">Status<select value={status} onChange={(e) => setStatus(e.target.value)} className={input}><option value="">All</option><option value="attention">Needs attention</option>{WORKLIST_STATUSES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label className="text-sm font-medium">Client<select value={client} onChange={(e) => setClient(e.target.value)} className={input}><option value="">All clients</option>{clients.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        {officesOn ? <label className="text-sm font-medium">Office<select value={office} onChange={(e) => setOffice(e.target.value)} className={input}><option value="">All offices</option>{offices.filter((o) => o.isActive).map((o) => <option key={o.officeId} value={o.officeId}>{o.name}</option>)}</select></label> : null}
        <label className="text-sm font-medium">Program<select value={program} onChange={(e) => setProgram(e.target.value)} className={input}><option value="">All programs</option>{programs.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="text-sm font-medium">Runs on or after<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></label>
        <label className="text-sm font-medium">Starts on or before<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} /></label>
        <label className="text-sm font-medium">"Expiring" means within (days)<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} className={input} /></label>
      </section>

      {all.isPending ? <p>Loading…</p> : null}
      {all.isError ? <p role="alert">The worklist could not be loaded. Check your connection and try again.</p> : null}
      {all.isSuccess && rows.length === 0 ? <p>Nothing to show for these filters.</p> : null}
      {rows.length > 0 ? <div className="overflow-x-auto"><table className="min-w-full text-left text-sm" aria-label="Authorization worklist">
        <thead><tr>{["Status", "Client", "Office", "Service", "Program", "Ends", "Authorized", "Used", "Scheduled", "Remaining"].map((h) => <th key={h} className="whitespace-nowrap border-b border-slate-300 px-2 py-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.clientId}-${r.serviceId}-${r.authorizationId ?? "none"}`} className="align-top odd:bg-slate-50" data-testid="worklist-row">
          <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[r.status]}`}>{statusLabel(r.status)}</span></td>
          <td className="px-2 py-2"><Link className="underline" to={`/clients/${r.clientId}`}>{r.clientCode}</Link></td>
          <td className="px-2 py-2">{r.officeName ?? ""}</td><td className="px-2 py-2">{r.serviceName}</td><td className="px-2 py-2">{r.program ?? ""}</td>
          <td className="px-2 py-2">{day(r.periodEnd)}{r.daysToExpiry !== null && r.daysToExpiry >= 0 && r.daysToExpiry <= 30 ? ` (${r.daysToExpiry} d)` : ""}</td>
          <td className="px-2 py-2">{hoursText(r.authorizedMinutes)}</td><td className="px-2 py-2">{hoursText(r.usedMinutes)}</td><td className="px-2 py-2">{hoursText(r.scheduledMinutes)}</td>
          <td className="px-2 py-2">{r.status === "missing" ? "No authorization" : hoursText(r.remainingMinutes)}</td>
        </tr>)}</tbody></table></div> : null}
    </div>
  );
}
