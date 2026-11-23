// Assigned Offices, Service County and Caregiver Color controls (0111, behind the officeAssignments release switch). They identify and filter people; they grant no access and change no schedule, hour or status.
// Every control stays out of sight unless the facets actually loaded (`ready`), because with the switch off the routes do not exist.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { CA_COUNTIES } from "./ca-counties";
import { formatDateTime } from "@/lib/service-verification";
import { CaregiverColorPicker, ColorSwatch } from "./caregiver-color";
import { caregiverColor } from "./caregiver-colors";
import { useAwsApi } from "./aws-workspace";
import { type OfficeRow, useOffices, usePeopleFacets } from "./offices-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const selectClass = "mt-1 min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-base md:min-h-[36px]";

/** Compact office names, primary first and marked; "Unassigned" when there are none. Retired offices keep showing on existing assignments. */
export function OfficeNames({ ids, offices }: { ids: readonly string[] | undefined; offices: readonly OfficeRow[] }) {
  if (!ids || ids.length === 0) return <span className="text-slate-500">Unassigned</span>;
  const name = (id: string) => offices.find((o) => o.officeId === id);
  return (
    <span data-testid="office-names">
      {ids.map((id, i) => (
        <span key={id}>{i > 0 ? ", " : ""}<span className={i === 0 ? "font-medium" : ""}>{name(id)?.name ?? "Office"}</span>{name(id) && !name(id)!.isActive ? " (retired)" : ""}{i === 0 && ids.length > 1 ? " (primary)" : ""}</span>
      ))}
    </span>
  );
}

/** Assigned Offices for one client or caregiver: zero, one or many; when any exist exactly one is primary (the first added by default). */
export function OfficeAssignmentsControl({ kind, subjectId }: { kind: "client" | "caregiver"; subjectId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { offices, available } = useOffices();
  const facets = usePeopleFacets(available);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [adding, setAdding] = useState("");
  const canEdit = hasPermission(kind === "client" ? "clients.manage" : "caregivers.manage");
  if (!available || !facets.ready) return null;
  const ids = (kind === "client" ? facets.clientOffices : facets.caregiverOffices).get(subjectId) ?? [];
  const primary = ids[0] ?? null;
  const path = kind === "client" ? `/v1/clients/${subjectId}/offices` : `/v1/caregivers/${subjectId}/offices`;

  async function save(nextPrimary: string | null, nextSecondary: string[]) {
    setState({ busy: true, error: null });
    try {
      await api.post(path, { organizationId: activeOrganizationId, primaryOfficeId: nextPrimary, secondaryOfficeIds: nextSecondary });
      await queryClient.invalidateQueries({ queryKey: ["people-facets"] }); await queryClient.invalidateQueries({ queryKey: ["assignment-history"] });
      await queryClient.invalidateQueries({ queryKey: ["offices"] });
      await queryClient.invalidateQueries({ queryKey: ["client-offices"] });
      setAdding("");
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again.") }); }
  }
  const remove = (id: string) => { const rest = ids.filter((x) => x !== id); void save(rest[0] ?? null, rest.slice(1)); };
  const makePrimary = (id: string) => void save(id, ids.filter((x) => x !== id));
  const add = (id: string) => { if (!id) return; if (!primary) void save(id, []); else void save(primary, [...ids.slice(1), id]); };
  const addable = offices.filter((o) => o.isActive && !ids.includes(o.officeId));
  const label = (id: string) => offices.find((o) => o.officeId === id);

  return (
    <div className="text-sm" data-testid="office-assignments">
      <p className="font-medium text-slate-700">Assigned Offices</p>
      {ids.length === 0 ? <p className="mt-1 text-slate-600">Unassigned</p> : (
        <ul aria-label="Assigned Offices" className="mt-1 space-y-1">
          {ids.map((id, i) => (
            <li key={id} className="flex flex-wrap items-center gap-2">
              <span className={i === 0 ? "font-semibold text-slate-900" : "text-slate-800"}>{label(id)?.name ?? "Office"}{label(id) && !label(id)!.isActive ? " (retired)" : ""}</span>
              {i === 0 ? <span className="rounded-full bg-og-ink px-2 py-0.5 text-xs font-medium text-white">Primary</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">Additional</span>}
              {canEdit ? (
                <>
                  {i > 0 ? <Button type="button" variant="secondary" disabled={state.busy} onClick={() => makePrimary(id)}>Make primary</Button> : null}
                  <Button type="button" variant="secondary" disabled={state.busy} onClick={() => remove(id)} aria-label={`Remove ${label(id)?.name ?? "office"}`}>Remove</Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && addable.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-sm font-medium text-slate-700">{ids.length === 0 ? "Assign an office" : "Add an office"}
            <select value={adding} disabled={state.busy} onChange={(e) => add(e.target.value)} className={`${selectClass} block`}>
              <option value="">Choose an office</option>
              {addable.map((o) => <option key={o.officeId} value={o.officeId}>{o.name}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-red-700">{state.error}</p> : null}
    </div>
  );
}

/** Service County for a client (one): where the client receives services. Independent of office and address. */
export function ClientServiceCountyControl({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { available } = useOffices();
  const facets = usePeopleFacets(available);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!available || !facets.ready) return null;
  const current = facets.clientCounty.get(clientId) ?? "";
  const canEdit = hasPermission("clients.manage");
  async function choose(county: string) {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/clients/${clientId}/service-county`, { organizationId: activeOrganizationId, county: county || null });
      await queryClient.invalidateQueries({ queryKey: ["people-facets"] }); await queryClient.invalidateQueries({ queryKey: ["assignment-history"] });
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again.") }); }
  }
  return (
    <div className="text-sm">
      <label htmlFor="client-service-county" className="block font-medium text-slate-700">Service County</label>
      {canEdit ? (
        <select id="client-service-county" value={current} disabled={state.busy} onChange={(e) => void choose(e.target.value)} className={selectClass}>
          <option value="">Not set</option>
          {CA_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : <p id="client-service-county" className="mt-1 text-slate-800">{current || "Not set"}</p>}
      <p className="mt-1 text-xs text-slate-500">Where the client receives services. Not taken from the address.</p>
      {state.error ? <p role="alert" className="mt-1 text-red-700">{state.error}</p> : null}
    </div>
  );
}

/** Service Counties for a caregiver (many): where the caregiver is available to work. Independent of office and availability. */
export function CaregiverServiceCountiesControl({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { available } = useOffices();
  const facets = usePeopleFacets(available);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!available || !facets.ready) return null;
  const current = facets.caregiverCounties.get(caregiverRecordId) ?? [];
  const canEdit = hasPermission("caregivers.manage");
  async function save(next: string[]) {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${caregiverRecordId}/service-counties`, { organizationId: activeOrganizationId, counties: next });
      await queryClient.invalidateQueries({ queryKey: ["people-facets"] }); await queryClient.invalidateQueries({ queryKey: ["assignment-history"] });
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again.") }); }
  }
  return (
    <div className="text-sm">
      <p className="font-medium text-slate-700">Service Counties</p>
      {current.length === 0 ? <p className="mt-1 text-slate-600">None set</p> : (
        <ul aria-label="Service Counties" className="mt-1 flex flex-wrap gap-1.5">
          {current.map((c) => (
            <li key={c} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-slate-800">
              {c}
              {canEdit ? <button type="button" disabled={state.busy} onClick={() => void save(current.filter((x) => x !== c))} aria-label={`Remove ${c} County`} className="min-h-[24px] min-w-[24px] rounded-full text-slate-600 hover:text-slate-950">×</button> : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <label className="mt-2 block text-sm font-medium text-slate-700">Add a county
          <select value="" disabled={state.busy} onChange={(e) => { if (e.target.value) void save([...current, e.target.value]); }} className={`${selectClass} block`}>
            <option value="">Choose a county</option>
            {CA_COUNTIES.filter((c) => !current.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      ) : null}
      <p className="mt-1 text-xs text-slate-500">Where the caregiver is available to work. Not taken from the address.</p>
      {state.error ? <p role="alert" className="mt-1 text-red-700">{state.error}</p> : null}
    </div>
  );
}

/** Caregiver Color on a caregiver's profile (caregivers.manage); read-only swatch elsewhere. */
export function CaregiverColorControl({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { available } = useOffices();
  const facets = usePeopleFacets(available);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!available || !facets.ready || !hasPermission("caregivers.manage")) return null;
  const current = facets.caregiverColor.get(caregiverRecordId) ?? null;
  async function choose(color: string | null) {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${caregiverRecordId}/color`, { organizationId: activeOrganizationId, color });
      await queryClient.invalidateQueries({ queryKey: ["people-facets"] }); await queryClient.invalidateQueries({ queryKey: ["assignment-history"] });
      setState({ busy: false, error: null });
    } catch (cause) { setState({ busy: false, error: message(cause, "Could not save. Check your connection and try again.") }); }
  }
  return (
    <div className="text-sm">
      <CaregiverColorPicker value={current} onChange={(c) => void choose(c)} disabled={state.busy} />
      <p className="mt-1 text-xs text-slate-500">Shown beside the caregiver&apos;s name on lists, the schedule and the Reports chart. It does not change any status or hours.</p>
      {state.error ? <p role="alert" className="mt-1 text-red-700">{state.error}</p> : null}
    </div>
  );
}

/** The Office and County filters shared by the client and Care Team lists. "All Offices" shows everyone; "Unassigned" shows people with no office; a chosen office matches ANY of a person's offices. */
export function OfficeCountyFilters({ idPrefix, offices, counties, office, onOffice, county, onCounty }: {
  idPrefix: string; offices: readonly OfficeRow[]; counties: readonly string[]; office: string; onOffice: (v: string) => void; county: string; onCounty: (v: string) => void;
}) {
  const cls = "mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base";
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-office-filter`} className="block text-sm font-medium text-slate-700">Office</label>
        <select id={`${idPrefix}-office-filter`} value={office} onChange={(e) => onOffice(e.target.value)} className={cls}>
          <option value="">All Offices</option>
          <option value="none">Unassigned</option>
          {offices.map((o) => <option key={o.officeId} value={o.officeId}>{o.name}{o.isActive ? "" : " (retired)"}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-county-filter`} className="block text-sm font-medium text-slate-700">County</label>
        <select id={`${idPrefix}-county-filter`} value={county} onChange={(e) => onCounty(e.target.value)} className={cls}>
          <option value="">All Counties</option>
          <option value="none">Not set</option>
          {counties.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
    </>
  );
}

/** Small colour marker for a caregiver wherever the schedule names them. Renders nothing when the caregiver has no colour or the colours are not available; the name is always shown beside it. */
export function CaregiverMarker({ caregiverRecordId }: { caregiverRecordId: string | null | undefined }) {
  const facets = usePeopleFacets(true);
  if (!caregiverRecordId || !facets.ready) return null;
  return <ColorSwatch color={facets.caregiverColor.get(caregiverRecordId)} className="mr-1" />;
}

/** Optional "Primary office" choice on the Add client / Add caregiver forms. Renders nothing where offices are not available or the user may not assign. After the record is created the form calls `assignOfficeAfterCreate`. */
export function NewRecordOffice({ kind, value, onChange }: { kind: "client" | "caregiver"; value: string; onChange: (v: string) => void }) {
  const { hasPermission } = useOrganization();
  const { offices, available } = useOffices();
  const facets = usePeopleFacets(available);
  if (!available || !facets.ready || !hasPermission(kind === "client" ? "clients.manage" : "caregivers.manage")) return null;
  const active = offices.filter((o) => o.isActive);
  if (active.length === 0) return null;
  return (
    <div className="sm:col-span-2">
      <label htmlFor={`new-${kind}-office`} className="block text-sm font-medium text-slate-700">Primary office (optional)</label>
      <select id={`new-${kind}-office`} value={value} onChange={(e) => onChange(e.target.value)} className={`${selectClass} block`}>
        <option value="">Unassigned</option>
        {active.map((o) => <option key={o.officeId} value={o.officeId}>{o.name}</option>)}
      </select>
      <p className="mt-1 text-xs text-slate-500">Add more offices, or change the primary one, on the profile after saving.</p>
    </div>
  );
}

type HistoryEvent = { occurredAt: string; action: string; actorName: string | null; beforeState: Record<string, unknown> | null; afterState: Record<string, unknown> | null };
const COLOR_NAME = (k: unknown) => (typeof k === "string" ? caregiverColor(k)?.label ?? k : "none");

/** Who changed an office assignment, service county or caregiver colour, and when (newest first). Read from the audit trail. */
export function AssignmentHistory({ kind, subjectId }: { kind: "client" | "caregiver"; subjectId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { offices, available } = useOffices();
  const facets = usePeopleFacets(available);
  const allowed = kind === "client" ? hasPermission("clients.manage") || hasPermission("clients.names.read") || hasPermission("visits.manage") : hasPermission("caregivers.manage") || hasPermission("visits.manage");
  const q = useQuery({
    queryKey: ["assignment-history", activeOrganizationId, kind, subjectId],
    queryFn: async () => (await api.get<{ events: HistoryEvent[] }>("/v1/assignment-history", { organizationId: activeOrganizationId, subjectType: kind, subjectId })).events,
    enabled: available && facets.ready && allowed && !!activeOrganizationId,
    retry: false,
  });
  if (!available || !facets.ready || !allowed || !q.isSuccess) return null;
  const officeName = (id: unknown) => offices.find((o) => o.officeId === id)?.name ?? "Office";
  const officeList = (s: Record<string, unknown> | null) => {
    const ids = Array.isArray(s?.offices) ? (s!.offices as string[]) : [];
    return ids.length === 0 ? "Unassigned" : ids.map((id, i) => `${officeName(id)}${i === 0 && ids.length > 1 ? " (primary)" : ""}`).join(", ");
  };
  const describe = (e: HistoryEvent) => {
    switch (e.action) {
      case "client.offices_set": case "caregiver.offices_set": return `Offices: ${officeList(e.afterState)} (was: ${officeList(e.beforeState)})`;
      case "client.service_county_set": return `Service County: ${(e.afterState?.service_county as string) || "not set"} (was: ${(e.beforeState?.service_county as string) || "not set"})`;
      case "caregiver.service_counties_set": return `Service Counties: ${((e.afterState?.counties as string[]) ?? []).join(", ") || "none"} (was: ${((e.beforeState?.counties as string[]) ?? []).join(", ") || "none"})`;
      case "caregiver.color_set": return `Caregiver Color: ${COLOR_NAME(e.afterState?.color)} (was: ${COLOR_NAME(e.beforeState?.color)})`;
      default: return e.action.replace(/[._]/g, " ");
    }
  };
  return (
    <details className="text-sm" data-testid="assignment-history">
      <summary className="min-h-[44px] cursor-pointer py-2 font-medium text-slate-700 md:min-h-0 md:py-0">Assignment history ({q.data.length})</summary>
      {q.data.length === 0 ? <p className="mt-1 text-slate-600">No changes recorded yet.</p> : (
        <ul aria-label="Assignment history" className="mt-1 space-y-1">
          {q.data.map((e, i) => (
            <li key={`${e.occurredAt}-${i}`} className="text-slate-800">
              <span className="text-xs text-slate-600">{formatDateTime(e.occurredAt)} · {e.actorName ?? "Someone"}</span><br />{describe(e)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
