import { MatchingLocation } from "./readiness/matching-inputs";
import { CaregiverServices } from "./readiness/service-approvals";
import { SortTh } from "./ui/sort-th";
import { useSortedRows } from "./ui/table-sort";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { AssignmentsCard } from "./assignments-card";
import { useAwsApi } from "./aws-workspace";
import {
  CAREGIVER_STATUS_LABEL, WORK_STATUS_BADGE, WORK_STATUS_LABEL, caregiverName, signInLabel, useCaregivers,
  type Caregiver, type CaregiverStatus, type WorkStatus,
} from "./care-team-admin";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import type { StaffDocument } from "./document-status";
import { CaregiverReadiness } from "./readiness/caregiver-readiness";
import { ReadinessCard } from "./readiness/readiness-card";
import { AvailabilityReview } from "./readiness/availability-review";
import { ReadinessChecklist } from "./readiness/readiness-checklist";
import { useCaregiverReadiness, useSigninOverrides } from "./readiness/readiness-data";
import { OverrideBadge } from "./readiness/override-badge";
import { SendSignInLink } from "./readiness/send-signin-link";
import { SummarySection } from "./ui/summary-section";
import { InfoTip } from "./ui/info-tip";
import { ColorSwatch } from "./caregiver-color";
import { AssignmentHistory, CaregiverColorControl, CaregiverServiceCountiesControl, NewRecordOffice, OfficeAssignmentsControl, OfficeCountyFilters, OfficeNames } from "./office-assignments";
import { EditableRow, ProfileBlock, ProfileRow, ProfileTabs, StatusChip, rowButton, type Tone } from "./profile-ui";
import { documentStatusLabel } from "./readiness/format";
import { ExportMenu } from "./export-menu";
import { assignOfficeAfterCreate, countyMatches, officeMatches, useOffices, usePeopleFacets } from "./offices-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm";
const WORK_STATUSES: readonly WorkStatus[] = ["not_ready", "approved", "active", "inactive"];

function useRefreshCareTeam() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-caregivers", "aws-document-people", "people-facets", "assignment-history"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

function NameFields({ v, set, idPrefix }: { v: { first: string; last: string; preferred: string }; set: (k: "first" | "last" | "preferred") => (x: string) => void; idPrefix: string }) {
  return (
    <>
      <div><label htmlFor={`${idPrefix}-first`} className="block text-xs font-medium text-slate-700">First name</label><input id={`${idPrefix}-first`} value={v.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-last`} className="block text-xs font-medium text-slate-700">Last name</label><input id={`${idPrefix}-last`} value={v.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor={`${idPrefix}-preferred`} className="block text-xs font-medium text-slate-700">Preferred name (optional)</label><input id={`${idPrefix}-preferred`} value={v.preferred} maxLength={80} autoComplete="off" onChange={(e) => set("preferred")(e.target.value)} className={inputClass} /></div>
    </>
  );
}

function AddCaregiverForm({ onDone }: { onDone: (id: string, note?: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: "", last: "", preferred: "" });
  const [zip, setZip] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const lookup = useQuery({
    queryKey: ["matching-city-suggestion", activeOrganizationId, zip],
    enabled: !!activeOrganizationId && /^\d{5}$/.test(zip) && city === null,
    queryFn: () => api.get<{ city: string | null; candidates?: string[] }>("/v1/location-data", { organizationId: activeOrganizationId, suggestZip: zip }),
    retry: false,
  });
  const displayedCity = city ?? lookup.data?.city ?? "";
  const [status, setStatus] = useState<Exclude<CaregiverStatus, "inactive" | "interview" | "offer" | "pending_documents">>("applicant");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [office, setOffice] = useState("");
  const key = useRef(newIdempotencyKey());
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name." });
    if (lookup.isFetching) return;
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ caregiver: { caregiverRecordId: string } }>("/v1/caregivers", {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null, status,
        ...(zip ? { zip, city: displayedCity.trim() || null } : {}),
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      const note = await assignOfficeAfterCreate(api, activeOrganizationId, "caregiver", r.caregiver.caregiverRecordId, office);
      await refresh();
      setState({ busy: false, error: null });
      onDone(r.caregiver.caregiverRecordId, note ?? undefined);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The caregiver was not added.") });
    }
  }
  return (
    <Card>
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-slate-950">Add a caregiver</h2>
        <InfoTip>A new person starts as an Applicant or Onboarding. Open their record to see what is left; Approve for work is enabled once background check, training and app sign-in are done.</InfoTip>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="new-cg" />
        <label>ZIP code (optional)<input className={inputClass} inputMode="numeric" pattern="[0-9]{5}" maxLength={5} value={zip}
          onChange={(e) => { setZip(e.target.value); setCity(null); key.current = newIdempotencyKey(); }} /></label>
        <label>City (optional)<input className={inputClass} list="new-cg-cities" maxLength={100} value={displayedCity}
          onChange={(e) => { setCity(e.target.value); key.current = newIdempotencyKey(); }} /></label>
        <datalist id="new-cg-cities">{lookup.data?.candidates?.map((candidate) => <option key={candidate} value={candidate} />)}</datalist>
        {lookup.isFetching ? <p role="status">Looking up the city…</p> : null}
        {lookup.isError ? <p role="status">City lookup is unavailable. Enter the city manually.</p> : null}
        <div>
          <label htmlFor="new-cg-status" className="block text-xs font-medium text-slate-700">Starting status</label>
          <select id="new-cg-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
            {(["applicant", "onboarding"] as const).map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <NewRecordOffice kind="caregiver" value={office} onChange={setOffice} />
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy || lookup.isFetching}>{state.busy ? "Adding…" : "Add caregiver"}</Button></div>
      </form>
    </Card>
  );
}

/** Care Team (0023): caregiver records, their status and whether they can sign in. */
export function CareTeamPage() {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("caregivers.manage");
  const caregivers = useCaregivers();
  const overrides = useSigninOverrides();
  const overridden = new Set((overrides.data ?? []).map((o) => o.caregiverRecordId));
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<WorkStatus | "current" | "all">("current");
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(() => params.get("add") === "1");
  const [added, setAdded] = useState<string | null>(null);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const { offices, available: officesOn } = useOffices();
  const facets = usePeopleFacets(officesOn);
  const peopleReady = officesOn && facets.ready;
  const [officeFilter, setOfficeFilter] = useState("");
  const [countyFilter, setCountyFilter] = useState("");
  const countiesInUse = useMemo(() => [...new Set([...facets.caregiverCounties.values()].flat())].sort(), [facets.caregiverCounties]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    // A caregiver appears once however many offices or counties match: the filters test "any of" their lists, never join rows.
    return (caregivers.data ?? []).filter((c) => (status === "all" || (status === "current" ? c.workStatus !== "inactive" : c.workStatus === status))
      && (!s || [caregiverName(c), c.caregiverCode].some((x) => x.toLowerCase().includes(s)))
      && officeMatches(officeFilter, facets.caregiverOffices.get(c.caregiverRecordId))
      && countyMatches(countyFilter, facets.caregiverCounties.get(c.caregiverRecordId)));
  }, [caregivers.data, search, status, officeFilter, countyFilter, facets.caregiverOffices, facets.caregiverCounties]);
  const { rows: sortedCaregivers, sort: cgSort } = useSortedRows(shown, {
    caregiver: { get: (c) => caregiverName(c) },
    status: { get: (c) => WORK_STATUS_LABEL[c.workStatus] },
  });
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  const counts = (caregivers.data ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.workStatus]: (acc[c.workStatus] ?? 0) + 1 }), {});
  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><h1 className="text-xl font-bold tracking-tight text-og-ink">Caregivers</h1><InfoTip label="About Caregivers" title="Caregivers">Manage caregiver profiles, services and onboarding.</InfoTip></div>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add caregiver"}</Button> : null}
      </div>
      {canManage && adding ? <AddCaregiverForm onDone={(id, note) => { setAdding(false); setAdded(id); setAddedNote(note ?? null); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Caregiver added. <Link className="underline" to={`/care-team/${added}`}>Open the record</Link>.{addedNote ? <span className="text-red-700"> {addedNote}</span> : null}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
          <label htmlFor="cg-search" className="text-xs font-medium text-slate-700">Search</label>
          <input id="cg-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" className="block w-full rounded-lg border border-slate-200 px-2.5 py-1 text-sm md:min-h-8" />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="cg-status" className="text-xs font-medium text-slate-700">Status</label>
          <select id="cg-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm md:min-h-8">
            <option value="current">Current ({(caregivers.data ?? []).filter((c) => c.workStatus !== "inactive").length})</option>
            {WORK_STATUSES.map((s) => <option key={s} value={s}>{WORK_STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
            <option value="all">All ({caregivers.data?.length ?? 0})</option>
          </select>
        </div>
        {peopleReady ? <OfficeCountyFilters idPrefix="cg" offices={offices} counties={countiesInUse} office={officeFilter} onOffice={setOfficeFilter} county={countyFilter} onCounty={setCountyFilter} /> : null}
      </div>
      {shown.length > 0 ? <ExportMenu basename="caregiver-readiness" sheet="Caregiver readiness" rows={sortedCaregivers.map((c) => ({ caregiver: caregiverName(c), code: c.caregiverCode ?? "", status: WORK_STATUS_LABEL[c.workStatus], met: c.workStatus === "not_ready" ? c.readinessMet ?? 0 : "", total: c.workStatus === "not_ready" ? c.readinessTotal ?? "" : "", signedIn: c.signedIn ? "Yes" : "No", assignments: c.activeAssignments, openVisits: c.openVisits }))}
        columns={[["Caregiver", "caregiver"], ["Code", "code"], ["Work status", "status"], ["Requirements met", "met"], ["Requirements total", "total"], ["Signed in to the app", "signedIn"], ["Active assignments", "assignments"], ["Visits in progress", "openVisits"]]} /> : null}
      {caregivers.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {caregivers.isError ? <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p> : null}
      {caregivers.data && shown.length === 0 ? <p className="text-sm text-slate-600">No caregivers match.</p> : null}
      {shown.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-og-card">
          <table className="w-full text-left text-sm" aria-label="Caregivers">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="w-10 px-3 py-1 text-right font-semibold">No.</th>
                <SortTh sort={cgSort} column="caregiver" className="px-3 py-0.5">Caregiver</SortTh>
                <SortTh sort={cgSort} column="status" className="px-3 py-0.5">Status</SortTh>
                {peopleReady ? <th scope="col" className="px-3 py-1 font-semibold">Offices</th> : null}
              </tr>
            </thead>
            <tbody>
              {sortedCaregivers.map((c, i) => (
                <tr key={c.caregiverRecordId} className="border-b border-slate-100 last:border-0">
                  <td className="w-10 px-3 py-1 text-right align-middle tabular-nums text-slate-600" data-testid="row-no">{i + 1}</td>
                  <th scope="row" className="px-3 py-1 font-normal">
                    <Link to={`/care-team/${c.caregiverRecordId}`} className="inline-flex min-h-[44px] flex-wrap items-baseline gap-x-3 gap-y-0 py-0.5 md:min-h-[30px]">
                      {peopleReady ? <ColorSwatch color={facets.caregiverColor.get(c.caregiverRecordId)} /> : null}
                      <span className="font-semibold text-slate-950 underline">{caregiverName(c)}</span>
                      <span className={`text-xs font-normal ${c.hasSignIn ? "text-slate-700" : "text-amber-900"}`}>
                        {signInLabel(c)} · {c.activeAssignments} active assignment{c.activeAssignments === 1 ? "" : "s"}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
                      </span>
                      {!c.hasSignIn && overridden.has(c.caregiverRecordId) ? <OverrideBadge /> : null}
                    </Link>
                  </th>
                  <td className="px-3 py-1 align-middle">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${WORK_STATUS_BADGE[c.workStatus]}`}>{WORK_STATUS_LABEL[c.workStatus]}</span>
                    {c.workStatus === "not_ready" && c.readinessTotal ? <span className="ml-2 text-xs text-slate-700">{c.readinessMet ?? 0} of {c.readinessTotal} done</span> : null}
                    {!c.signedIn && c.workStatus !== "inactive" ? <SendSignInLink caregiverRecordId={c.caregiverRecordId} hasContact={!!c.hasContact} canManage={canManage} lastSentAt={c.invitationLastSentAt ?? null} /> : null}
                  </td>
                  {peopleReady ? <td className="px-3 py-1 align-middle text-slate-800"><OfficeNames ids={facets.caregiverOffices.get(c.caregiverRecordId)} offices={offices} />{(facets.caregiverCounties.get(c.caregiverRecordId) ?? []).length > 0 ? <span className="block text-xs text-slate-600">{(facets.caregiverCounties.get(c.caregiverRecordId) ?? []).join(", ")}</span> : null}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {/* Status first, then the list, then the control rows: readiness and availability requests are collapsed one-line summaries below the list. */}
      <div id="readiness-setup"><ReadinessCard /></div>
      <AvailabilityReview />
    </div>
  );
}

function CaregiverContactEmail({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [email, setEmail] = useState<string | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const roster = useQuery({
    queryKey: ["aws-staff", activeOrganizationId],
    queryFn: () => api.get<{ staff: { caregiverRecordId: string | null; contactEmail: string | null }[] }>("/v1/staff", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && hasPermission("staff.read"),
  });
  const savedEmail = roster.data?.staff.find((row) => row.caregiverRecordId === c.caregiverRecordId)?.contactEmail;
  return <Card>
    <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={async (event) => {
      event.preventDefault();
      if (saving || !email?.trim()) return;
      setSaving(true); setResult(null);
      try {
        await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/contact`, {
          organizationId: activeOrganizationId, email: email.trim(),
        }, { idempotencyKey: newIdempotencyKey() });
        setEmail(null);
        setResult({ error: false, text: "Contact email saved." });
        await Promise.all(["aws-staff", "aws-caregivers", "caregiver-readiness", "aws-accounts"].map((key) =>
          qc.invalidateQueries({ queryKey: [key] })));
      } catch (cause) {
        setResult({ error: true, text: message(cause, "Email could not be saved.") });
      } finally { setSaving(false); }
    }}>
      <label className="text-sm font-medium">Caregiver contact email
        <input className={inputClass} type="email" autoComplete="off" required maxLength={254}
          placeholder="Enter the caregiver's email" value={email ?? savedEmail ?? ""} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <Button type="submit" disabled={saving || !email?.trim()}>{saving ? "Saving…" : "Save contact email"}</Button>
      <p className="text-xs text-slate-600 sm:col-span-2">{!hasPermission("staff.read") ? "Your role cannot view the saved contact." : roster.isError ? "Saved contact could not be loaded." : roster.isLoading ? "Loading saved contact…" : !savedEmail ? "No contact email saved." : "The saved contact email is in the row above."} Use App sign-in to manage invitations. Saving a contact address does not update an existing sign-in email.</p>
      {result ? <p role={result.error ? "alert" : "status"} className="text-sm sm:col-span-2">{result.text}</p> : null}
    </form>
  </Card>;
}
function CaregiverDetails({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setV({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" }), [c.firstName, c.lastName, c.preferredName]);
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  async function save() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/details`, {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  return (
    <SummarySection title="Name" summary={caregiverName(c)}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="edit-cg" />
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved. The change is in the record's history.</p> : null}
        <div className="flex items-center gap-2 sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save name"}</Button><InfoTip>Past visits keep the name they were recorded with.</InfoTip></div>
      </form>
    </SummarySection>
  );
}

/** One caregiver record (0023). */
const HIRE_LABEL = { direct_hire: "Direct Hire", eor: "EOR (employer of record)" } as const;
const SCHEDULING_LABEL = { fixed: "Fixed — works scheduled shifts", flexible: "Flexible — authorized visits without a scheduled shift" } as const;

/** 0030: hire type and scheduling arrangement are separate facts; neither implies a family relationship. */
function EmploymentCard({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [hire, setHire] = useState<string>(c.hireType ?? "");
  const [mode, setMode] = useState<string>(c.schedulingMode ?? "fixed");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function save() {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/employment`, { organizationId: activeOrganizationId, hireType: hire || null, schedulingMode: mode },
        { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ["aws-caregivers"] });
      setState({ busy: false, error: null, done: "Saved. Visit rules are unchanged: sign-in, assignment, authorization, confirmation and hour limits still apply." });
    } catch (cause) { setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved.", done: null }); }
  }
  return (
    <div aria-label="Hire type and scheduling">
      {!canManage ? (
        <p className="mt-1 text-sm text-slate-700">{c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"} · {SCHEDULING_LABEL[c.schedulingMode ?? "fixed"]}</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <div><label htmlFor="emp-hire" className="block text-xs font-medium text-slate-700">Hire type</label>
            <select id="emp-hire" value={hire} onChange={(e) => { setHire(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="">Not recorded</option><option value="direct_hire">{HIRE_LABEL.direct_hire}</option><option value="eor">{HIRE_LABEL.eor}</option>
            </select></div>
          <div><label htmlFor="emp-mode" className="block text-xs font-medium text-slate-700">Scheduling</label>
            <select id="emp-mode" value={mode} onChange={(e) => { setMode(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="fixed">{SCHEDULING_LABEL.fixed}</option><option value="flexible">{SCHEDULING_LABEL.flexible}</option>
            </select></div>
          <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Save hire type and scheduling"}</Button>
          <p className="flex items-center gap-1.5 text-xs text-slate-600 sm:col-span-3">Family relationship is recorded per client on each assignment.<InfoTip>EOR does not mean family, and Direct Hire does not require fixed shifts.</InfoTip></p>
          {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}

        </form>
      )}
    </div>
  );
}

/** Hire date (0055): the office may enter one that is not recorded; changing a recorded one is an administrator action, audited with a reason. */
function HireDateForm({ c }: { c: Caregiver }) {
  const readiness = useCaregiverReadiness(c.caregiverRecordId);
  const hireDate = readiness.data?.hireDate ?? null;
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ date: "", reason: "" });
  useEffect(() => setV((o) => ({ ...o, date: hireDate ?? "" })), [hireDate]);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  async function save() {
    if (!v.date) return setState({ busy: false, error: "Choose the hire date.", done: false });
    if (v.reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the hire date.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/hire-date`, { organizationId: activeOrganizationId, hireDate: v.date, reason: v.reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      await qc.invalidateQueries({ queryKey: ["caregiver-readiness"] });
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end" aria-label="Hire date">
      <div><label htmlFor="hire-date" className="block text-xs font-medium text-slate-700">Hire date</label><input id="hire-date" type="date" value={v.date} onChange={(e) => { setV((o) => ({ ...o, date: e.target.value })); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <div><label htmlFor="hire-reason" className="block text-xs font-medium text-slate-700">Reason</label><input id="hire-reason" value={v.reason} maxLength={500} onChange={(e) => { setV((o) => ({ ...o, reason: e.target.value })); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Save hire date"}</Button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-3">Saved. The change is in the audit history.</p> : null}
    </form>
  );
}

/** Deactivate is the one manual status. Re-approval (Approve for work) reactivates. Ends assignments and suspends sign-in; refused during a visit. */
function DeactivateForm({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function save() {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ result: { endedAssignments: number } }>(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/status`,
        { organizationId: activeOrganizationId, status: "inactive", reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setReason("");
      await refresh();
      await qc.invalidateQueries({ queryKey: ["caregiver-readiness"] });
      setState({ busy: false, error: null, done: `Deactivated.${r.result.endedAssignments > 0 ? ` ${r.result.endedAssignments} assignment${r.result.endedAssignments === 1 ? "" : "s"} ended.` : ""} Their sign-in is suspended for this agency.` });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not deactivated."), done: null });
    }
  }
  // Stays mounted after a successful deactivation so the result (assignments ended, sign-in suspended) is still shown.
  if (c.workStatus === "inactive" && !state.done) return null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" aria-label="Deactivate caregiver">
      <div><label htmlFor="deactivate-reason" className="block text-xs font-medium text-slate-700">Deactivate: ends assignments and suspends sign-in. Reason</label>
        <input id="deactivate-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Deactivate"}</Button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}
    </form>
  );
}

/** Documents are uploaded and reviewed on the Documents page. This is a plain file list: no review or status labels. */
function CaregiverFiles({ caregiverRecordId }: { caregiverRecordId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const docs = useQuery({
    queryKey: ["aws-documents", activeOrganizationId],
    queryFn: async () => (await api.get<{ documents: StaffDocument[] }>("/v1/documents", { organizationId: activeOrganizationId })).documents,
    enabled: !!activeOrganizationId && hasPermission("documents.read"),
  });
  if (!hasPermission("documents.read")) return null;
  const mine = (docs.data ?? []).filter((d) => d.caregiverRecordId === caregiverRecordId && d.latestVersionId);
  return (
    <SummarySection title="Documents" summary={docs.data ? `${mine.length} file${mine.length === 1 ? "" : "s"}` : undefined}>
      {docs.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {docs.isError ? <p role="alert" className="text-sm text-red-700">{message(docs.error, "Documents could not be loaded.")}</p> : null}
      {docs.data && mine.length === 0 ? <p className="text-sm text-slate-700">No files uploaded.</p> : null}
      <ul className="divide-y divide-slate-100">
        {mine.map((d) => <li key={d.documentId} className="py-1 text-sm text-slate-900">{d.documentTypeName}<span className="text-slate-600"> · version {d.latestVersionNumber}{d.latestUploadedAt ? `, uploaded ${formatDateTime(d.latestUploadedAt)}` : ""}</span></li>)}
      </ul>
      <p className="mt-1 text-sm"><Link to="/documents" className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[28px]">Open the Documents page</Link></p>
    </SummarySection>
  );
}

function CaregiverProfileSwatch({ caregiverRecordId }: { caregiverRecordId: string }) {
  const { available } = useOffices();
  const facets = usePeopleFacets(available);
  return facets.ready ? <ColorSwatch color={facets.caregiverColor.get(caregiverRecordId)} /> : null;
}

/** Tabs of the caregiver profile (CG redesign). Each row shows the saved value; the editor opens only on Edit or Manage. */
const PROFILE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "readiness", label: "Readiness" },
  { id: "assignments", label: "Assignments & availability" },
  { id: "documents", label: "Documents" },
] as const;
type ProfileTabId = (typeof PROFILE_TABS)[number]["id"];
const isProfileTab = (v: string | null): v is ProfileTabId => PROFILE_TABS.some((t) => t.id === v);

function OverviewTab({ c, canManage, onManageSignIn }: { c: Caregiver; canManage: boolean; onManageSignIn: () => void }) {
  const { hasPermission } = useOrganization();
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const readiness = useCaregiverReadiness(c.caregiverRecordId, canManage || hasPermission("readiness.read"));
  const { offices, available } = useOffices();
  const facets = usePeopleFacets(available);
  const roster = useQuery({
    queryKey: ["aws-staff", activeOrganizationId],
    queryFn: () => api.get<{ staff: { caregiverRecordId: string | null; contactEmail: string | null }[] }>("/v1/staff", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && hasPermission("staff.read"),
  });
  const contact = roster.data?.staff.find((row) => row.caregiverRecordId === c.caregiverRecordId)?.contactEmail ?? null;
  const signInEmail = c.invitationEmail ?? null;
  const differs = !!contact && !!signInEmail && contact.trim().toLowerCase() !== signInEmail.trim().toLowerCase();
  const signInTone: Tone = c.hasSignIn && c.signInStatus === "active" ? (c.invitedAt && !c.firstSignedInAt ? "warn" : "ok") : "neutral";
  const hire = readiness.data?.hireDate ?? null;
  const counties = facets.ready ? facets.caregiverCounties.get(c.caregiverRecordId) ?? [] : null;
  return (
    <div className="space-y-3">
      {canManage ? (
        <ProfileBlock title="Contact and sign-in">
          <EditableRow testId="row-contact-email" label="Contact email" canEdit={canManage}
            value={!hasPermission("staff.read") ? <span className="text-slate-600">Your role cannot view the saved contact.</span> : roster.isError ? <span role="alert" className="text-red-700">Saved contact could not be loaded.</span> : roster.isLoading ? "Loading…" : contact ?? <span className="text-slate-600">Not recorded</span>}
            status={contact ? <StatusChip tone="saved">Saved</StatusChip> : roster.isSuccess ? <StatusChip tone="neutral">Not recorded</StatusChip> : null}>
            <CaregiverContactEmail key={c.caregiverRecordId} c={c} />
          </EditableRow>
          <ProfileRow testId="row-app-signin" label="App sign-in"
            value={<>{signInEmail ?? (c.hasSignIn ? "Signed in" : <span className="text-slate-600">No sign-in yet</span>)}{differs ? <span className="mt-0.5 block text-xs text-amber-900" data-testid="signin-differs">Different from the contact email. Open-shift alerts go to the contact email; the sign-in stays as it is.</span> : null}</>}
            status={<StatusChip tone={signInTone}>{signInLabel(c)}</StatusChip>}
            action={<button type="button" className={rowButton} onClick={onManageSignIn} aria-label="Manage app sign-in">Manage sign-in</button>} />
        </ProfileBlock>
      ) : null}
      {canManage ? (
        <ProfileBlock title="Employment">
          <EditableRow testId="row-hire-date" label="Hire date" canEdit value={hire ? formatDateOnlyLabel(hire) : <span className="text-slate-600">Not recorded</span>}
            status={hire ? <StatusChip tone="saved">Saved</StatusChip> : <StatusChip tone="neutral">Not recorded</StatusChip>}><HireDateForm c={c} /></EditableRow>
          <EditableRow testId="row-hire-type" label="Hire type" canEdit value={c.hireType ? HIRE_LABEL[c.hireType] : <span className="text-slate-600">Not recorded</span>}
            status={c.hireType ? <StatusChip tone="saved">Saved</StatusChip> : <StatusChip tone="neutral">Not recorded</StatusChip>}><EmploymentCard c={c} canManage={canManage} /></EditableRow>
          <EditableRow testId="row-scheduling-type" label="Scheduling type" canEdit value={c.schedulingMode === "flexible" ? "Flexible" : "Fixed"}
            status={<StatusChip tone="saved">Saved</StatusChip>}><EmploymentCard c={c} canManage={canManage} /></EditableRow>
        </ProfileBlock>
      ) : null}
      <ProfileBlock title="Offices and service area">
        <EditableRow testId="row-offices" label="Assigned offices" canEdit={canManage} actionLabel="Manage"
          value={available ? <OfficeNames ids={facets.caregiverOffices.get(c.caregiverRecordId)} offices={offices} /> : <span className="text-slate-600">Not available yet</span>}>
          <OfficeAssignmentsControl kind="caregiver" subjectId={c.caregiverRecordId} />
        </EditableRow>
        <EditableRow testId="row-counties" label="Service counties" canEdit={canManage}
          value={counties === null ? <span className="text-slate-600">Not available yet</span> : counties.length ? counties.join(", ") : <span className="text-slate-600">None chosen</span>}>
          <CaregiverServiceCountiesControl caregiverRecordId={c.caregiverRecordId} />
        </EditableRow>
        {hasPermission("matching.manage") ? <li className="px-3 py-2" data-testid="row-location"><MatchingLocation caregiverRecordId={c.caregiverRecordId} /></li> : null}
        {available ? <li className="px-3 py-2" data-testid="row-assignment-history"><AssignmentHistory kind="caregiver" subjectId={c.caregiverRecordId} /></li> : null}
      </ProfileBlock>
      {canManage ? (
        <SummarySection title="Name and record" summary={`${caregiverName(c)} · ${c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"}`}>
          <div className="space-y-3"><CaregiverDetails c={c} /><DeactivateForm c={c} /></div>
        </SummarySection>
      ) : null}
    </div>
  );
}
const formatDateOnlyLabel = (d: string) => formatDateOnly(d);

function ReadinessTab({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const { hasPermission } = useOrganization();
  return (
    <div className="space-y-3">
      <ReadinessChecklist caregiverRecordId={c.caregiverRecordId} canManage={canManage} hasContact={!!c.hasContact} />
      {hasPermission("caregiver_services.read") ? <CaregiverServices caregiverRecordId={c.caregiverRecordId} /> : null}
    </div>
  );
}

function AssignmentsTab({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const { available } = useOffices();
  const facets = usePeopleFacets(available);
  const colorKey = facets.ready ? facets.caregiverColor.get(c.caregiverRecordId) ?? null : null;
  return (
    <div className="space-y-3">
      <AssignmentsCard caregiverRecordId={c.caregiverRecordId} />
      <CaregiverReadiness caregiverRecordId={c.caregiverRecordId} />
      {canManage && available ? (
        <ProfileBlock title="Scheduling preferences">
          <EditableRow testId="row-schedule-color" label="Schedule color" canEdit
            value={colorKey ? <span className="inline-flex items-center gap-2"><ColorSwatch color={colorKey} />Chosen</span> : <span className="text-slate-600">Optional. None chosen.</span>}>
            <CaregiverColorControl caregiverRecordId={c.caregiverRecordId} />
          </EditableRow>
        </ProfileBlock>
      ) : null}
    </div>
  );
}

function DocumentsTab({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canSee = hasPermission("documents.read") || hasPermission("readiness.read") || hasPermission("caregivers.manage");
  const q = useQuery({
    queryKey: ["document-readiness", activeOrganizationId, c.caregiverRecordId],
    queryFn: async () => (await api.get<{ readiness: { requirements: { requirement: "cpr" | "tb"; status: string; validUntil: string | null }[] } }>("/v1/document-readiness", { organizationId: activeOrganizationId, caregiverRecordId: c.caregiverRecordId })).readiness.requirements,
    enabled: !!activeOrganizationId && canSee,
  });
  const ready = useCaregiverReadiness(c.caregiverRecordId, canSee);
  const due = (req: "cpr" | "tb") => ready.data?.items.find((i) => i.requirement === req)?.dueDate ?? null;
  if (!canSee) return <p className="text-sm text-slate-600">Your role cannot view documents.</p>;
  return (
    <div className="space-y-3">
      <ProfileBlock title="Required documents">
        {q.isLoading ? <li className="px-3 py-2 text-sm text-slate-500">Loading…</li> : null}
        {q.isError ? <li role="alert" className="px-3 py-2 text-sm text-red-700">Document status could not be loaded.</li> : null}
        {(q.data ?? []).map((r) => {
          const s = documentStatusLabel(r.status, r.requirement);
          const tone: Tone = s.ok ? "ok" : s.label === "Setup incomplete" ? "warn" : s.label === "Needs review" ? "warn" : s.label === "Expired" || s.label === "Unverified" ? "bad" : "neutral";
          const label = s.label === "Setup incomplete" ? "Document type not set up" : s.label === "Needs review" ? "Pending review" : s.label === "Missing" || s.label === "Not provided" ? "Not recorded" : s.label;
          const date = r.validUntil && s.ok ? `Valid through ${formatDateOnlyLabel(r.validUntil)}` : due(r.requirement) ? `Due ${formatDateOnlyLabel(due(r.requirement)!)}` : "";
          return <ProfileRow key={r.requirement} testId={`doc-${r.requirement}`} label={r.requirement === "cpr" ? "CPR certificate" : "TB clearance"} status={<StatusChip tone={tone}>{label}</StatusChip>}
            value={date || <span className="text-slate-600">{s.detail ?? ""}</span>}
            action={hasPermission("documents.read") ? <Link to="/documents" className={rowButton}>Open documents</Link> : null} />;
        })}
      </ProfileBlock>
      <CaregiverFiles caregiverRecordId={c.caregiverRecordId} />
    </div>
  );
}

export function CaregiverDetailPage() {
  const { caregiverRecordId } = useParams<{ caregiverRecordId: string }>();
  const { hasPermission } = useOrganization();
  const caregivers = useCaregivers();
  const overrides = useSigninOverrides();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab");
  const tab: ProfileTabId = isProfileTab(rawTab) ? rawTab : "overview";
  const setTab = (id: string) => { const next = new URLSearchParams(params); next.set("tab", id); setParams(next, { replace: true }); };
  const { offices, available } = useOffices();
  const facets = usePeopleFacets(available);
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  if (caregivers.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (caregivers.isError) return <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p>;
  const c = caregivers.data?.find((x) => x.caregiverRecordId === caregiverRecordId);
  if (!c) return <p className="text-sm text-slate-600">Caregiver not found. <Link to="/care-team" className="underline">Back to the Care Team</Link></p>;
  const canManage = hasPermission("caregivers.manage");
  const primary = available ? facets.caregiverOffices.get(c.caregiverRecordId)?.[0] : undefined;
  const primaryName = primary ? offices.find((o) => o.officeId === primary)?.name : undefined;
  return (
    <div className="max-w-3xl space-y-3">
      <div>
        <Link to="/care-team" className="inline-flex min-h-[44px] items-center text-sm text-slate-700 underline md:min-h-0">← Care Team</Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-950"><CaregiverProfileSwatch caregiverRecordId={c.caregiverRecordId} />{caregiverName(c)}</h1>
          {!c.hasSignIn && (overrides.data ?? []).some((o) => o.caregiverRecordId === c.caregiverRecordId) ? <OverrideBadge /> : null}
        </div>
        {primaryName ? <p className="text-sm text-slate-600">{primaryName} primary office</p> : null}
      </div>
      <ProfileTabs tabs={PROFILE_TABS} active={tab} onChange={setTab} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="max-md:[&_button]:min-h-[44px]">   {/* phone: every button in the profile is at least 44 px tall */}
        {tab === "overview" ? <OverviewTab c={c} canManage={canManage} onManageSignIn={() => setTab("readiness")} /> : null}
        {tab === "readiness" ? <ReadinessTab c={c} canManage={canManage} /> : null}
        {tab === "assignments" ? <AssignmentsTab c={c} canManage={canManage} /> : null}
        {tab === "documents" ? <DocumentsTab c={c} /> : null}
      </div>
      <Link to="/care-team" className="inline-block text-sm underline">Back to all caregivers</Link>
    </div>
  );
}
