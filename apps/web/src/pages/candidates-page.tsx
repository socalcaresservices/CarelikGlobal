import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Clipboard, Download, FileUp, Plus } from "lucide-react";
import { Button, Card, FilterBar, PageHeader, ProgressBar, StatusBadge, type ActiveFilter, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Human-controlled recruiting workspace. Ogevia displays and records
// administrative pipeline data here. It never ranks, recommends, selects,
// or rejects people automatically.
interface CandidateRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  pipeline_stage: string;
  source: string;
  position_applied_for: string | null;
  applied_at: string;
  desired_weekly_hours: number | null;
  available_start_date: string | null;
  imported_at: string | null;
  created_at: string;
}

interface ImportCandidate {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  source: string;
  source_record_id: string;
  position_applied_for: string;
  applied_at: string;
}

interface ImportPreviewRow {
  row_number: number;
  disposition: "new" | "possible_duplicate" | "invalid";
  reason: string | null;
  candidate: ImportCandidate;
}

const PIPELINE_STAGES = [
  "imported",
  "application_needed",
  "application_received",
  "screening",
  "interview",
  "conditional_offer",
  "hired_onboarding_required",
  "onboarding_scheduled",
  "onboarding",
  "compliance_pending",
  "ready_to_work",
  "care_team",
  "on_hold",
  "rejected",
  "withdrawn"
] as const;

const IMPORT_SOURCES = ["indeed", "ziprecruiter", "referral", "agency_website", "manual", "other"] as const;

const stageTone: Record<string, StatusTone> = {
  imported: "neutral",
  application_needed: "warning",
  application_received: "info",
  screening: "info",
  interview: "info",
  conditional_offer: "warning",
  hired_onboarding_required: "success",
  onboarding_scheduled: "warning",
  onboarding: "warning",
  compliance_pending: "warning",
  ready_to_work: "success",
  care_team: "success",
  on_hold: "neutral",
  rejected: "neutral",
  withdrawn: "neutral"
};

function formatLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findHeaderIndex(headers: string[], aliases: string[]) {
  return aliases.map((alias) => headers.indexOf(alias)).find((index) => index >= 0) ?? -1;
}

function normalizeImportRows(text: string, source: string): ImportCandidate[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map(normalizeHeader);
  const firstIndex = findHeaderIndex(headers, ["first_name", "firstname", "first", "candidate_first_name"]);
  const lastIndex = findHeaderIndex(headers, ["last_name", "lastname", "last", "surname", "candidate_last_name"]);
  const fullIndex = findHeaderIndex(headers, ["name", "candidate_name", "full_name", "applicant_name"]);
  const emailIndex = findHeaderIndex(headers, ["email", "email_address", "candidate_email"]);
  const phoneIndex = findHeaderIndex(headers, ["phone", "phone_number", "mobile", "mobile_phone", "candidate_phone"]);
  const sourceIdIndex = findHeaderIndex(headers, ["candidate_id", "application_id", "applicant_id", "source_id", "id"]);
  const positionIndex = findHeaderIndex(headers, ["job", "job_title", "position", "position_applied_for", "role", "job_name"]);
  const appliedIndex = findHeaderIndex(headers, ["applied", "applied_at", "applied_date", "application_date", "date_applied", "created_at"]);

  return rows.slice(1).map((values) => {
    const fullName = fullIndex >= 0 ? (values[fullIndex] ?? "").trim() : "";
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const appliedRaw = appliedIndex >= 0 ? (values[appliedIndex] ?? "").trim() : "";
    const appliedDate = appliedRaw ? new Date(appliedRaw) : null;
    return {
      first_name: firstIndex >= 0 ? (values[firstIndex] ?? "").trim() : nameParts[0] ?? "",
      last_name: lastIndex >= 0 ? (values[lastIndex] ?? "").trim() : nameParts.slice(1).join(" "),
      email: emailIndex >= 0 ? (values[emailIndex] ?? "").trim().toLowerCase() : "",
      phone: phoneIndex >= 0 ? (values[phoneIndex] ?? "").trim() : "",
      source,
      source_record_id: sourceIdIndex >= 0 ? (values[sourceIdIndex] ?? "").trim() : "",
      position_applied_for: positionIndex >= 0 ? (values[positionIndex] ?? "").trim() : "",
      applied_at: appliedDate && !Number.isNaN(appliedDate.getTime()) ? appliedDate.toISOString() : new Date().toISOString()
    };
  });
}

export function CandidatesPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canRead = hasPermission("applicants.read");
  const canManage = hasPermission("applicants.update");

  const candidatesQuery = useQuery({
    queryKey: ["candidates", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_candidates_v1", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CandidateRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const filters = useFilters<CandidateRow>(candidatesQuery.data, {
    stage: (row, value) => row.pipeline_stage === value,
    source: (row, value) => row.source === value
  });

  const table = useTableControls<CandidateRow, "name" | "stage" | "applied">(filters.rows, {
    matchesSearch: (row, query) =>
      `${row.first_name} ${row.last_name}`.toLowerCase().includes(query) ||
      row.email.toLowerCase().includes(query) ||
      (row.phone ?? "").toLowerCase().includes(query) ||
      (row.position_applied_for ?? "").toLowerCase().includes(query),
    sorters: {
      name: (a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
      stage: (a, b) => a.pipeline_stage.localeCompare(b.pipeline_stage),
      applied: (a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime()
    },
    defaultSort: "applied"
  });

  const sourceOptions = Array.from(new Set((candidatesQuery.data ?? []).map((row) => row.source))).sort();
  const columns = useColumnWidths("carelik:column-widths:candidates", {
    name: 210,
    stage: 190,
    source: 120,
    position: 170,
    hours: 120,
    applied: 120
  });

  const activeFilters: ActiveFilter[] = [
    filters.values.stage
      ? { key: "stage", label: `Stage: ${formatLabel(filters.values.stage)}`, onRemove: () => filters.setFilter("stage", "") }
      : null,
    filters.values.source
      ? { key: "source", label: `Source: ${formatLabel(filters.values.source)}`, onRemove: () => filters.setFilter("source", "") }
      : null
  ].filter((entry): entry is ActiveFilter => entry !== null);

  const [applicationCopied, setApplicationCopied] = useState(false);
  const [applicationCopyError, setApplicationCopyError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState("indeed");
  const [importRows, setImportRows] = useState<ImportCandidate[]>([]);
  const [previewRows, setPreviewRows] = useState<ImportPreviewRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [stageSavingId, setStageSavingId] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualCandidate, setManualCandidate] = useState({ first_name: "", last_name: "", email: "", phone: "", position_applied_for: "", notes: "" });

  const previewCounts = useMemo(() => ({
    new: previewRows.filter((row) => row.disposition === "new").length,
    duplicate: previewRows.filter((row) => row.disposition === "possible_duplicate").length,
    invalid: previewRows.filter((row) => row.disposition === "invalid").length
  }), [previewRows]);

  async function copyApplicationLink() {
    if (!activeOrganization?.slug) return;
    const link = `${window.location.origin}/apply/${activeOrganization.slug}`;
    setApplicationCopyError(null);
    try {
      await navigator.clipboard.writeText(link);
      setApplicationCopied(true);
      window.setTimeout(() => setApplicationCopied(false), 1800);
    } catch {
      setApplicationCopyError(link);
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !activeOrganizationId) return;
    setImportBusy(true);
    setImportError(null);
    setImportMessage(null);
    try {
      const text = await file.text();
      const rows = normalizeImportRows(text, importSource);
      setImportRows(rows);
      setImportFileName(file.name);
      const { data, error } = await supabase.rpc("preview_candidate_import", {
        target_organization_id: activeOrganizationId,
        import_rows: rows
      });
      if (error) throw error;
      setPreviewRows((data ?? []) as ImportPreviewRow[]);
    } catch (cause) {
      setImportRows([]);
      setPreviewRows([]);
      setImportError(cause instanceof Error ? cause.message : "Could not preview this import file.");
    } finally {
      setImportBusy(false);
    }
  }

  async function importCandidates() {
    if (!activeOrganizationId || importRows.length === 0) return;
    setImportBusy(true);
    setImportError(null);
    setImportMessage(null);
    try {
      const { data, error } = await supabase.rpc("import_candidates_v1", {
        target_organization_id: activeOrganizationId,
        import_rows: importRows
      });
      if (error) throw error;
      const result = (Array.isArray(data) ? data[0] : data) as { inserted_count?: number; skipped_count?: number } | undefined;
      setImportMessage(`${result?.inserted_count ?? 0} imported · ${result?.skipped_count ?? 0} skipped`);
      setPreviewRows([]);
      setImportRows([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      void queryClient.invalidateQueries({ queryKey: ["candidates", activeOrganizationId] });
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not import candidates.");
    } finally {
      setImportBusy(false);
    }
  }

  async function changeStage(row: CandidateRow, nextStage: string) {
    if (!activeOrganizationId || nextStage === row.pipeline_stage) return;
    setStageSavingId(row.id);
    setStageError(null);
    try {
      const { error } = await supabase.rpc("set_candidate_stage", {
        target_organization_id: activeOrganizationId,
        target_applicant_id: row.id,
        target_stage: nextStage,
        stage_note: null
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["candidates", activeOrganizationId] });
      void queryClient.invalidateQueries({ queryKey: ["applicant-detail", activeOrganizationId, row.id] });
    } catch (cause) {
      setStageError(cause instanceof Error ? cause.message : "Could not update the candidate stage.");
    } finally {
      setStageSavingId(null);
    }
  }

  async function createManualCandidate() {
    if (!activeOrganizationId) return;
    setManualBusy(true);
    setManualError(null);
    try {
      const { error } = await supabase.rpc("create_manual_candidate", {
        target_organization_id: activeOrganizationId,
        candidate_payload: manualCandidate
      });
      if (error) throw error;
      setManualCandidate({ first_name: "", last_name: "", email: "", phone: "", position_applied_for: "", notes: "" });
      setShowManual(false);
      void queryClient.invalidateQueries({ queryKey: ["candidates", activeOrganizationId] });
    } catch (cause) {
      setManualError(cause instanceof Error ? cause.message : "Could not create this candidate.");
    } finally {
      setManualBusy(false);
    }
  }

  function exportFilteredCandidates() {
    const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = ["First name", "Last name", "Email", "Phone", "Stage", "Source", "Position", "Desired weekly hours", "Applied"];
    const rows = table.rows.map((row) => [row.first_name, row.last_name, row.email, row.phone, row.pipeline_stage, row.source, row.position_applied_for, row.desired_weekly_hours, row.applied_at]);
    const blob = new Blob([[header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Candidates</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">You don&apos;t have permission to view candidates for this organization.</p>
        </Card>
      </section>
    );
  }

  // Funnel counts come from the full unfiltered candidate list, not
  // table.rows - a report of "where is everyone in the pipeline right
  // now" should stay accurate regardless of whatever search/stage/source
  // filter someone has active on the table below it.
  const allCandidates = candidatesQuery.data ?? [];
  const funnelCounts = PIPELINE_STAGES.reduce<Record<string, number>>((counts, stage) => {
    counts[stage] = 0;
    return counts;
  }, {});
  for (const candidate of allCandidates) {
    funnelCounts[candidate.pipeline_stage] = (funnelCounts[candidate.pipeline_stage] ?? 0) + 1;
  }
  const largestStageCount = Math.max(1, ...Object.values(funnelCounts));

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow="People"
        title="Candidates"
        description={`Recruiting and onboarding pipeline${activeOrganization?.displayName ? ` for ${activeOrganization.displayName}` : ""}. Candidate stages are changed by authorized staff.`}
      />

      <Card>
        <h3 className="font-semibold text-slate-950">Pipeline funnel</h3>
        <p className="mt-1 text-xs text-slate-500">How many candidates are at each stage right now, out of {allCandidates.length} total.</p>
        <div className="mt-4 space-y-3">
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{formatLabel(stage)}</span>
                <span className="text-slate-500">{funnelCounts[stage]}</span>
              </div>
              <ProgressBar value={funnelCounts[stage] ?? 0} max={largestStageCount} tone={stageTone[stage] ?? "neutral"} />
            </div>
          ))}
        </div>
      </Card>

      {canManage ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-950">Add candidates</h3>
              <p className="mt-1 text-sm text-slate-500">Use the organization application link or import a CSV exported from Indeed, ZipRecruiter, or another recruiting system.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setShowManual((value) => !value)}>
                <Plus className="mr-1.5 h-4 w-4" /> Add candidate
              </Button>
              <Button type="button" variant="secondary" onClick={() => void copyApplicationLink()}>
                <Clipboard className="mr-1.5 h-4 w-4" /> {applicationCopied ? "Copied" : "Copy application link"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setShowImport((value) => !value)}>
                <FileUp className="mr-1.5 h-4 w-4" /> Import CSV
              </Button>
            </div>
          </div>
          {applicationCopyError ? <p className="mt-3 break-all rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Copy this link: {applicationCopyError}</p> : null}

          {showManual ? (
            <div className="mt-5 rounded-xl border border-slate-200 p-4">
              <h4 className="font-medium text-slate-900">Add a candidate manually</h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <input aria-label="First name" placeholder="First name" value={manualCandidate.first_name} onChange={(event) => setManualCandidate({ ...manualCandidate, first_name: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                <input aria-label="Last name" placeholder="Last name" value={manualCandidate.last_name} onChange={(event) => setManualCandidate({ ...manualCandidate, last_name: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                <input aria-label="Email" type="email" placeholder="Email" value={manualCandidate.email} onChange={(event) => setManualCandidate({ ...manualCandidate, email: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                <input aria-label="Phone" placeholder="Phone" value={manualCandidate.phone} onChange={(event) => setManualCandidate({ ...manualCandidate, phone: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                <input aria-label="Position" placeholder="Position applied for" value={manualCandidate.position_applied_for} onChange={(event) => setManualCandidate({ ...manualCandidate, position_applied_for: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-2" />
                <textarea aria-label="Notes" placeholder="Internal notes" value={manualCandidate.notes} onChange={(event) => setManualCandidate({ ...manualCandidate, notes: event.target.value })} className="min-h-20 rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-2" />
              </div>
              {manualError ? <p className="mt-3 text-sm text-red-700">{manualError}</p> : null}
              <div className="mt-3 flex gap-2"><Button disabled={!manualCandidate.first_name.trim() || !manualCandidate.last_name.trim() || !manualCandidate.email.trim()} loading={manualBusy} onClick={() => void createManualCandidate()}>Create candidate</Button><Button variant="secondary" onClick={() => setShowManual(false)}>Cancel</Button></div>
            </div>
          ) : null}

          {showImport ? (
            <div className="mt-5 rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-xs font-medium text-slate-600">
                  Recruiting source
                  <select
                    value={importSource}
                    onChange={(event) => setImportSource(event.target.value)}
                    className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  >
                    {IMPORT_SOURCES.map((source) => <option key={source} value={source}>{formatLabel(source)}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-600">
                  CSV file
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => void handleImportFile(event)}
                    className="mt-1 block max-w-xs text-sm"
                  />
                </label>
              </div>
              {importFileName ? <p className="mt-3 text-xs text-slate-500">{importFileName}</p> : null}
              {previewRows.length > 0 ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs font-medium text-emerald-700">New</p><p className="mt-1 text-xl font-semibold text-emerald-900">{previewCounts.new}</p></div>
                    <div className="rounded-lg bg-amber-50 p-3"><p className="text-xs font-medium text-amber-700">Possible duplicates</p><p className="mt-1 text-xl font-semibold text-amber-900">{previewCounts.duplicate}</p></div>
                    <div className="rounded-lg bg-red-50 p-3"><p className="text-xs font-medium text-red-700">Invalid</p><p className="mt-1 text-xl font-semibold text-red-900">{previewCounts.invalid}</p></div>
                  </div>
                  <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-slate-200">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-white"><tr><th className="px-3 py-2">Candidate</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Preview</th></tr></thead>
                      <tbody>
                        {previewRows.map((row) => (
                          <tr key={row.row_number} className="border-t border-slate-100">
                            <td className="px-3 py-2">{row.candidate.first_name} {row.candidate.last_name}</td>
                            <td className="px-3 py-2 text-slate-600">{row.candidate.email || "—"}</td>
                            <td className="px-3 py-2">
                              <StatusBadge
                                label={row.disposition === "possible_duplicate" ? "Possible duplicate" : formatLabel(row.disposition)}
                                tone={row.disposition === "new" ? "success" : row.disposition === "invalid" ? "danger" : "warning"}
                              />
                              {row.reason ? <p className="mt-1 text-xs text-slate-500">{row.reason}</p> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button type="button" loading={importBusy} disabled={previewCounts.new === 0 || importBusy} onClick={() => void importCandidates()}>
                      Import {previewCounts.new} new candidate{previewCounts.new === 1 ? "" : "s"}
                    </Button>
                    <p className="text-xs text-slate-500">Duplicates and invalid rows are skipped. Ogevia does not make any hiring decision from imported data.</p>
                  </div>
                </>
              ) : null}
              {importMessage ? <p className="mt-3 text-sm font-medium text-emerald-700">{importMessage}</p> : null}
              {importError ? <p className="mt-3 text-sm text-red-700">{importError}</p> : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-950">Candidate pipeline</h3>
            <p className="mt-1 text-xs text-slate-500">Imported applicants, direct applications, onboarding, and ready-to-work records in one view.</p>
          </div>
          <Button type="button" variant="secondary" onClick={exportFilteredCandidates} disabled={table.rows.length === 0}>
            <Download className="mr-1.5 h-4 w-4" /> Export filtered CSV
          </Button>
          <FilterBar
            activeFilters={activeFilters}
            onClearAll={activeFilters.length > 0 ? filters.clearAll : undefined}
            className="w-full sm:w-auto"
          >
            <input
              type="search"
              value={table.search}
              onChange={(event) => table.setSearch(event.target.value)}
              placeholder="Search name, email, phone, or position"
              aria-label="Search candidates"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            />
            <select
              aria-label="Filter by pipeline stage"
              value={filters.values.stage ?? ""}
              onChange={(event) => filters.setFilter("stage", event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            >
              <option value="">All stages</option>
              {PIPELINE_STAGES.map((stage) => <option key={stage} value={stage}>{formatLabel(stage)}</option>)}
            </select>
            <select
              aria-label="Filter by source"
              value={filters.values.source ?? ""}
              onChange={(event) => filters.setFilter("source", event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            >
              <option value="">All sources</option>
              {sourceOptions.map((source) => <option key={source} value={source}>{formatLabel(source)}</option>)}
            </select>
          </FilterBar>
        </div>

        {stageError ? <p className="mt-3 text-sm text-red-700">{stageError}</p> : null}
        {candidatesQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : candidatesQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load candidates. Apply the Candidate Hiring V1 database migration before deploying this page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-4 w-full min-w-[900px] table-fixed text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <SortableHeader label="Candidate" active={table.sortKey === "name"} direction={table.direction} onClick={() => table.toggleSort("name")} width={columns.widths.name} onResizeStart={columns.startResize("name")} />
                  <SortableHeader label="Stage" active={table.sortKey === "stage"} direction={table.direction} onClick={() => table.toggleSort("stage")} width={columns.widths.stage} onResizeStart={columns.startResize("stage")} />
                  <PlainHeader label="Source" width={columns.widths.source} onResizeStart={columns.startResize("source")} />
                  <PlainHeader label="Position" width={columns.widths.position} onResizeStart={columns.startResize("position")} />
                  <PlainHeader label="Desired hours" width={columns.widths.hours} onResizeStart={columns.startResize("hours")} />
                  <SortableHeader label="Applied" active={table.sortKey === "applied"} direction={table.direction} onClick={() => table.toggleSort("applied")} width={columns.widths.applied} onResizeStart={columns.startResize("applied")} />
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">
                      <Link to={`/candidates/${row.id}`} className="font-medium hover:underline">{row.first_name} {row.last_name}</Link>
                      <p className="truncate text-xs text-slate-500">{row.email}{row.phone ? ` · ${row.phone}` : ""}</p>
                    </td>
                    <td className="py-2.5">
                      {canManage ? (
                        <select
                          aria-label={`Stage for ${row.first_name} ${row.last_name}`}
                          disabled={stageSavingId === row.id}
                          value={row.pipeline_stage}
                          onChange={(event) => void changeStage(row, event.target.value)}
                          className="max-w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-60"
                        >
                          {PIPELINE_STAGES.map((stage) => <option key={stage} value={stage}>{formatLabel(stage)}</option>)}
                        </select>
                      ) : (
                        <StatusBadge label={formatLabel(row.pipeline_stage)} tone={stageTone[row.pipeline_stage] ?? "neutral"} />
                      )}
                    </td>
                    <td className="py-2.5 text-slate-600">{formatLabel(row.source)}</td>
                    <td className="truncate py-2.5 text-slate-600">{row.position_applied_for ?? "—"}</td>
                    <td className="py-2.5 text-slate-600">{row.desired_weekly_hours != null ? `${formatHours(row.desired_weekly_hours)}h/week` : "—"}</td>
                    <td className="py-2.5 text-slate-500">{new Date(row.applied_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {table.rows.length === 0 ? (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400">{table.search || activeFilters.length > 0 ? "No candidates match this view." : "No candidates yet."}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
