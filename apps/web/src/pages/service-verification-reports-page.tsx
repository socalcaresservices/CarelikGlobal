import { HoursBreakdown } from "@/components/hours-breakdown";
import { ShortHelp } from "@/aws/help-text";
import { hoursLeftText } from "@/lib/hours-accounting";
import { Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useIsNarrow } from "@/lib/use-is-narrow";
import {
  BarChart3,
  CalendarDays,
  Check,
  Copy,
  Download,
  FileText,
  Folder,
  MapPin,
  Printer,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Button,
  Card,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import {
  newIdempotencyKey,
  type ClientLocation,
  type CorrectionHistoryReportRow,
  type MonthlyApprovalSummaryRow,
  type MonthlyServiceSummaryRow,
  type OrgLetterhead,
  type VisitCorrectionRow,
  type VisitReportRow,
} from "@/lib/sv-backend";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import { buildClientMonthSummary } from "@/lib/client-month-summary";
import { CalendarSummary } from "@/components/calendar-summary";
import { useEnvironmentMarker } from "@/aws/environment";
import { AwsApiContext } from "@/aws/aws-workspace";
import { MonthlyChainReport } from "@/aws/monthly-chain-report";
import {
  AUTHORIZATION_STATUS_LABEL,
  classifyIncompleteVisit,
  UNSCHEDULED_OPEN_VISIT_ALERT_HOURS,
  formatDateOnly,
  getAgencyTimeZone,
  formatDateTime,
  formatDuration,
  formatScheduledWindow,
  formatTimeRange,
  formatClockTime,
  formatVisitDate,
  correctedTimeValue,
  pacificWallTimeToDate,
  toPacificWallTime,
  validateManagerTimeOut,
  VISIT_STATUS_LABEL,
  type PacificWallTime,
  type ServiceVisitStatus,
  authorizationStatus,
  formatBalance,
} from "@/lib/service-verification";
import { PacificCorrectionFields, PacificTimeOutField } from "@/components/pacific-time-out-field";





type ChartType = "bar" | "pie" | "line";
type ChartGroup = "caregiver" | "client" | "service" | "location";
type ReportView =
  | "overview"
  | "caregiver"
  | "calendar"
  | "reconciliation"
  | "corrections"
  | "visits"
  | "exceptions"
  | "staff-access";
type DatePreset =
  "all" | "today" | "week" | "biweekly" | "month" | "quarter" | "year" | "custom";

const DATE_PRESETS: Array<[DatePreset, string]> = [
  ["all", "All time"],
  ["today", "Today"],
  ["week", "This week"],
  ["biweekly", "Last 14 days"],
  ["month", "This month"],
  ["quarter", "This quarter"],
  ["year", "This year"],
  ["custom", "Custom"],
];

const REPORT_VIEWS: ReportView[] = ["overview", "caregiver", "calendar", "reconciliation", "corrections", "visits", "exceptions", "staff-access"];


type VisitColumn =
  | "visitRef"
  | "client"
  | "caregiver"
  | "service"
  | "date"
  | "time"
  | "worked"
  | "billable"
  | "authorized"
  | "usedMtd"
  | "remaining"
  | "status";

const VISIT_COLUMN_OPTIONS: Array<{ key: VisitColumn; label: string }> = [
  { key: "visitRef", label: "Visit ref" },
  { key: "client", label: "Client" },
  { key: "caregiver", label: "Caregiver" },
  { key: "service", label: "Service" },
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "worked", label: "Worked" },
  { key: "billable", label: "Billable" },
  { key: "authorized", label: "Authorized" },
  { key: "usedMtd", label: "Billable this month" },
  { key: "remaining", label: "Hours left" },
  { key: "status", label: "Status" },
];

// The three authorization columns are off by default: each row's "Hours left" control shows the
// same three values, so the table keeps Status and Actions in view. They stay available in Columns.
const BALANCE_COLUMNS: VisitColumn[] = ["authorized", "usedMtd", "remaining"];
const ALL_VISIT_COLUMNS = VISIT_COLUMN_OPTIONS.map((column) => column.key);
// The visit reference moves under the client name (still shown, in less width) so Status and Actions fit
// beside the expanded sidebar at 1440px; it is still a column in Columns.
const DEFAULT_VISIT_COLUMNS = ALL_VISIT_COLUMNS.filter((key) => !BALANCE_COLUMNS.includes(key) && key !== "visitRef");

const CHART_COLORS = [
  "#4f46e5",
  "#059669",
  "#0284c7",
  "#7c3aed",
  "#e11d48",
  "#d97706",
];

const STATUS_TONE: Record<ServiceVisitStatus, StatusTone> = {
  draft: "info",
  awaiting_signature: "warning",
  signed: "success",
  administrator_review: "danger",
  corrected: "neutral",
  voided: "neutral",
};

function overdueMinutes(issue: { kind: string; minutesOverdue?: number; minutesSinceTimeOut?: number }) {
  return issue.kind === "not_confirmed" ? (issue.minutesSinceTimeOut ?? 0) : (issue.minutesOverdue ?? 0);
}

function formatOverdue(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function sumMinutes(
  rows: VisitReportRow[],
  key: "worked_minutes" | "billable_minutes",
) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function csvQuote(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsvFile(filename: string, header: string[], rows: unknown[][]) {
  saveTextFile(filename, [header, ...rows].map((row) => row.map(csvQuote).join(",")).join("\r\n"));
}

/** Saves text the server (or, in the older build, the page) produced. */
function saveTextFile(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** A visit's client: the name (code beside it only where the server says the name is shared), or the code when no name is visible. */
function visitClientLabel(row: { client_legal_name: string | null; client_code: string; client_name_duplicate?: boolean | undefined }) {
  return row.client_legal_name ? (row.client_name_duplicate ? `${row.client_legal_name} (${row.client_code})` : row.client_legal_name) : row.client_code;
}

// Client name first (office roles with clients.names.read), code underneath.
// Without the names permission the server returns no name: the code alone.
function ClientCell({ name, code, duplicate }: { name?: string | null | undefined; code: string; duplicate?: boolean | undefined }) {
  return name ? (
    <>
      <p className="font-medium text-slate-800">{name}</p>
      {duplicate ? <p className="text-xs text-slate-500">{code}</p> : null}
    </>
  ) : (
    <p className="font-medium text-slate-800">{code}</p>
  );
}

// "Client name" column only when the report actually carries names.
function clientCsvHeader(rows: Array<{ clientName?: string | null | undefined }>): string[] {
  return rows.some((row) => row.clientName) ? ["Client name", "Client code"] : ["Client code"];
}
function clientCsvCells(rows: Array<{ clientName?: string | null | undefined }>, row: { clientName?: string | null | undefined; clientCode: string }): string[] {
  return rows.some((r) => r.clientName) ? [row.clientName ?? "", row.clientCode] : [row.clientCode];
}

const formatSignedDuration = (minutes: number) =>
  minutes === 0 ? "0 min" : `${minutes > 0 ? "+" : "−"}${formatDuration(Math.abs(minutes))}`;

// Excludes voided and superseded ('corrected') rows from every subtotal -
// a corrected visit's replacement carries the numbers that should count,
// and a voided visit was never real time to begin with.
function billableRows(rows: VisitReportRow[]) {
  return rows.filter(
    (row) => row.status === "signed" || row.status === "administrator_review",
  );
}

// The server's refusal message (both backends: an Error from the AWS API
// client, a plain { message } object from PostgREST), else the fallback.
function errorMessage(cause: unknown, fallback: string) {
  return cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message
    ? cause.message
    : fallback;
}

function currentPacificMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: getAgencyTimeZone(),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month
    ? `${year}-${month}`
    : new Date().toISOString().slice(0, 7);
}

function toDateValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function presetRange(preset: DatePreset) {
  const today = new Date();
  const start = new Date(today);
  if (preset === "today") {
    // start = today
  } else if (preset === "week") {
    const mondayOffset = (today.getDay() + 6) % 7;
    start.setDate(today.getDate() - mondayOffset);
  } else if (preset === "biweekly") {
    start.setDate(today.getDate() - 13);
  } else if (preset === "month") {
    start.setDate(1);
  } else if (preset === "quarter") {
    start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
  } else if (preset === "year") {
    start.setMonth(0, 1);
  } else {
    return { from: "", to: "" };
  }
  return { from: toDateValue(start), to: toDateValue(today) };
}

interface CalendarEntry {
  key: string;
  serviceName: string;
  workedMinutes: number;
  billableMinutes: number;
  needsReview: boolean;
}

function buildMonthCalendar(rows: VisitReportRow[], monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  if (!year || !month)
    return {
      weeks: [] as Array<Array<number | null>>,
      entries: new Map<string, CalendarEntry[]>(),
    };

  const dayCount = new Date(year, month, 0).getDate();
  const leadingDays = new Date(year, month - 1, 1).getDay();
  const cells: Array<number | null> = [
    ...Array.from({ length: leadingDays }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const entriesByDate = new Map<string, Map<string, CalendarEntry>>();
  for (const row of billableRows(rows)) {
    if (!row.service_date.startsWith(`${monthValue}-`)) continue;
    // Calendar reporting is intentionally grouped by SERVICE, never caregiver.
    // A client may hold multiple authorizations and those service buckets must
    // never be mixed on a date or in monthly totals.
    const serviceKey = row.service_id;
    const dayEntries =
      entriesByDate.get(row.service_date) ?? new Map<string, CalendarEntry>();
    const entry = dayEntries.get(serviceKey) ?? {
      key: serviceKey,
      serviceName: row.service_name,
      workedMinutes: 0,
      billableMinutes: 0,
      needsReview: false,
    };
    entry.workedMinutes += row.worked_minutes ?? 0;
    entry.billableMinutes += row.billable_minutes ?? 0;
    entry.needsReview ||= row.status === "administrator_review";
    dayEntries.set(serviceKey, entry);
    entriesByDate.set(row.service_date, dayEntries);
  }

  return {
    weeks: Array.from({ length: cells.length / 7 }, (_, index) =>
      cells.slice(index * 7, index * 7 + 7),
    ),
    entries: new Map(
      Array.from(entriesByDate.entries()).map(([date, dayEntries]) => [
        date,
        Array.from(dayEntries.values()).sort((a, b) =>
          a.serviceName.localeCompare(b.serviceName),
        ),
      ]),
    ),
  };
}

export function ServiceVerificationReportsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } =
    useOrganization();
  const canRead = hasPermission("visits.read");
  const canManage = hasPermission("visits.manage");
  // 0069/0072: in the AWS build an export needs reports.export and is MADE BY THE SERVER: it checks the permission, records the request, builds the file, records that it
  // generated it (rows, bytes, SHA-256) and only then returns it. The browser only saves what the server returned. Delivery to this device is not recorded.
  const awsApi = useContext(AwsApiContext);
  const canExport = awsApi ? hasPermission("reports.export") : true;
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const downloadCsv = (filename: string, header: string[], rows: unknown[][]) => {
    if (!awsApi) return downloadCsvFile(filename, header, rows);
    const report = filename.startsWith("client-service-calendar") ? "client_service_calendar" : filename.startsWith("monthly-service-reconciliation") ? "monthly_service_reconciliation" : "correction_history";
    const params = report === "correction_history"
      ? { dateFrom: dateFrom || null, dateTo: dateTo || null, clientId: clientFilter || null, serviceId: serviceFilter || null, caregiverUserId: caregiverFilter || null, correctedByUserId: correctedByFilter || null, status: statusFilter || null }
      : { monthStart: `${reportMonth}-01`, clientId: clientFilter || null };
    setExportError(null);
    setExportNotice(null);
    void awsApi.post<{ filename: string; csv: string; rowCount: number }>("/v1/exports", { organizationId: activeOrganizationId, report, params })
      .then((r) => {
        saveTextFile(r.filename, r.csv);
        setExportNotice(`The server generated ${r.filename} (${r.rowCount} row${r.rowCount === 1 ? "" : "s"}) and recorded the export. Whether the file reached this device is not recorded.`);
      })
      .catch((cause: unknown) => setExportError(cause instanceof Error ? cause.message : "The export was not made. Nothing was downloaded."));
  };
  const queryClient = useQueryClient();
  const backend = useServiceVerificationBackend();
  // Reused for retries of the same correction; renewed when the form changes.
  const correctionKey = useRef(newIdempotencyKey());

  const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);
  const [expandedMode, setExpandedMode] = useState<
    "correct" | "history" | null
  >(null);
  // Corrections are entered in Pacific time (date, hour, minute, AM/PM),
  // starting from the original record's times.
  const emptyWallTime: PacificWallTime = { date: "", hour: null, minute: null, meridiem: null };
  const [correctionForm, setCorrectionForm] = useState<{
    originalTimeIn: string;
    originalTimeOut: string | null;
    timeIn: PacificWallTime;
    timeOut: PacificWallTime;
    reason: string;
  }>({ originalTimeIn: "", originalTimeOut: null, timeIn: emptyWallTime, timeOut: emptyWallTime, reason: "" });
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  // Manager close-out of a missed clock-out (closeMissedVisit).
  const [closeForm, setCloseForm] = useState<{
    visitId: string;
    timeIn: string;
    timeOut: PacificWallTime;
    reason: string;
  } | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeKey = useRef(newIdempotencyKey());

  const [clientFilter, setClientFilter] = useState("");
  const [caregiverFilter, setCaregiverFilter] = useState(
    () => new URLSearchParams(window.location.search).get("caregiver") ?? "",
  );
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [correctedByFilter, setCorrectedByFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [chartGroup, setChartGroup] = useState<ChartGroup>("caregiver");
  const location = useLocation();
  const navigate = useNavigate();
  // A printout from a test or unverified environment says so on every page, so it cannot pass for a real record.
  const environmentMarker = useEnvironmentMarker();
  const viewFromUrl = new URLSearchParams(location.search).get("view");
  const defaultView: ReportView = backend.kind === "aws" ? "visits" : "overview";
  // Monthly hours & billing and Correction history read data only the AWS back end provides.
  // Offering them on another back end would show an empty report that looks like "no records".
  const viewAvailable = (view: string | null): view is ReportView =>
    REPORT_VIEWS.includes(view as ReportView) &&
    (view !== "reconciliation" || !!backend.listMonthlyServiceSummary) &&
    (view !== "corrections" || !!backend.listCorrectionHistoryReport);
  const [reportView, setReportView] = useState<ReportView>(() =>
    viewAvailable(viewFromUrl) ? viewFromUrl : defaultView,
  );
  // Navigation changes the open page too: a link to ?view=... (for example
  // NEEDS ATTENTION) opens that view, and the plain address (the "Visit
  // records" menu item) returns to the default. Choosing from the Report
  // dropdown does not change the address, so it is not overridden.
  useEffect(() => {
    setReportView(viewAvailable(viewFromUrl) ? viewFromUrl : defaultView);
    // viewAvailable only reads the back end, which defaultView already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFromUrl, defaultView]);
  const narrow = useIsNarrow();
  const [linkCopied, setLinkCopied] = useState(false);
  const [reportMonth, setReportMonth] = useState(currentPacificMonth);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [visitColumns, setVisitColumns] = useState<Set<VisitColumn>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ogevia.visit-report-columns") ?? "null");
      if (Array.isArray(saved)) {
        const allowed = new Set(VISIT_COLUMN_OPTIONS.map((column) => column.key));
        const valid = saved.filter((key): key is VisitColumn => allowed.has(key as VisitColumn));
        // Before the balance columns were hidden by default, the full set was saved automatically on every
        // visit. A saved full set is therefore treated as "never customised" and takes the new default;
        // any other saved choice is kept.
        const wasAutoSavedFullSet = valid.length === ALL_VISIT_COLUMNS.length;
        if (valid.length > 0 && !wasAutoSavedFullSet) return new Set(valid);
      }
    } catch {
      // Ignore a malformed local preference and use the safe default.
    }
    return new Set(DEFAULT_VISIT_COLUMNS);
  });

  const visitsQuery = useQuery({
    queryKey: [
      "service-visit-report",
      activeOrganizationId,
      clientFilter,
      caregiverFilter,
      serviceFilter,
      statusFilter,
      dateFrom,
      dateTo,
    ],
    queryFn: (): Promise<VisitReportRow[]> =>
      backend.listVisits(activeOrganizationId!, {
        clientId: clientFilter || null,
        caregiverUserId: caregiverFilter || null,
        serviceId: serviceFilter || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        status: statusFilter || null,
      }),
    enabled: !!activeOrganizationId && canRead,
  });

  const letterheadQuery = useQuery({
    queryKey: ["organization-letterhead", activeOrganizationId],
    queryFn: (): Promise<OrgLetterhead> =>
      backend.getLetterhead(activeOrganizationId!),
    enabled: !!activeOrganizationId && canRead,
  });

  const clientLocationsQuery = useQuery({
    queryKey: ["service-report-client-locations", activeOrganizationId],
    queryFn: (): Promise<ClientLocation[]> =>
      backend.listClientLocations(activeOrganizationId!),
    enabled: !!activeOrganizationId && canManage,
  });

  const correctionsQuery = useQuery({
    queryKey: ["visit-corrections", expandedVisitId],
    queryFn: (): Promise<VisitCorrectionRow[]> =>
      backend.listCorrections(expandedVisitId!),
    enabled: expandedMode === "history" && !!expandedVisitId,
  });

  const monthlyServiceSummaryQuery = useQuery({
    queryKey: [
      "monthly-service-summary",
      activeOrganizationId,
      clientFilter,
      reportMonth,
    ],
    queryFn: (): Promise<MonthlyServiceSummaryRow[]> =>
      backend.listMonthlyServiceSummary!(
        activeOrganizationId!,
        clientFilter || null,
        `${reportMonth}-01`,
      ),
    enabled:
      !!activeOrganizationId &&
      canRead &&
      !!backend.listMonthlyServiceSummary &&
      (reportView === "calendar" || reportView === "reconciliation"),
  });

  const monthlyApprovalSummaryQuery = useQuery({
    queryKey: ["monthly-approval-summary", activeOrganizationId, clientFilter, reportMonth],
    queryFn: (): Promise<MonthlyApprovalSummaryRow[]> =>
      backend.listMonthlyApprovalSummary!(activeOrganizationId!, clientFilter || null, `${reportMonth}-01`),
    enabled:
      !!activeOrganizationId &&
      canRead &&
      !!backend.listMonthlyApprovalSummary &&
      reportView === "reconciliation",
  });
  const approvedByLineage = useMemo(
    () => new Map((monthlyApprovalSummaryQuery.data ?? []).map((row) => [row.authorizationLineageId, row])),
    [monthlyApprovalSummaryQuery.data],
  );
  const showApproved = !!backend.listMonthlyApprovalSummary;

  const correctionHistoryReportQuery = useQuery({
    queryKey: [
      "correction-history-report",
      activeOrganizationId,
      dateFrom,
      dateTo,
      clientFilter,
      serviceFilter,
      caregiverFilter,
      correctedByFilter,
      statusFilter,
    ],
    queryFn: (): Promise<CorrectionHistoryReportRow[]> =>
      backend.listCorrectionHistoryReport!(
        activeOrganizationId!,
        dateFrom || null,
        dateTo || null,
        clientFilter || null,
        serviceFilter || null,
        caregiverFilter || null,
        correctedByFilter || null,
        statusFilter || null,
      ),
    enabled:
      !!activeOrganizationId &&
      canRead &&
      !!backend.listCorrectionHistoryReport &&
      reportView === "corrections",
  });

  useEffect(() => {
    correctionKey.current = newIdempotencyKey();
  }, [expandedVisitId, correctionForm]);

  useEffect(() => {
    localStorage.setItem(
      "ogevia.visit-report-columns",
      JSON.stringify(Array.from(visitColumns)),
    );
  }, [visitColumns]);

  function toggleVisitColumn(column: VisitColumn) {
    setVisitColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) {
        if (next.size > 1) next.delete(column);
      } else {
        next.add(column);
      }
      return next;
    });
  }

  function resetVisitColumns() {
    setVisitColumns(new Set(DEFAULT_VISIT_COLUMNS));
  }

  function openCorrect(row: VisitReportRow) {
    setExpandedVisitId(row.id);
    setExpandedMode("correct");
    setCorrectionError(null);
    setCorrectionForm({
      originalTimeIn: row.time_in,
      originalTimeOut: row.time_out,
      timeIn: toPacificWallTime(row.time_in),
      timeOut: row.time_out ? toPacificWallTime(row.time_out) : emptyWallTime,
      reason: "",
    });
  }

  function openHistory(row: VisitReportRow) {
    setExpandedVisitId(row.id);
    setExpandedMode("history");
  }

  function closeExpanded() {
    setExpandedVisitId(null);
    setExpandedMode(null);
    setCorrectionError(null);
  }

  async function handleSubmitCorrection(visitId: string) {
    setCorrectionError(null);
    if (!correctionForm.reason.trim()) {
      setCorrectionError("A reason is required to correct a visit.");
      return;
    }
    const parsedIn = correctedTimeValue(correctionForm.timeIn, correctionForm.originalTimeIn);
    if (!parsedIn.ok) {
      setCorrectionError(`Time In: ${parsedIn.error.replace("the visit ended", "the visit started")}`);
      return;
    }
    const parsedOut = correctedTimeValue(correctionForm.timeOut, correctionForm.originalTimeOut);
    if (!parsedOut.ok) {
      setCorrectionError(`Time Out: ${parsedOut.error}`);
      return;
    }
    const newTimeOut = parsedOut.value;
    const invalid = validateManagerTimeOut(parsedIn.iso, newTimeOut);
    if (invalid) {
      setCorrectionError(invalid);
      return;
    }

    setCorrectionSaving(true);
    try {
      await backend.correctVisit({
        visitId,
        timeIn: parsedIn.iso,
        timeOut: parsedOut.iso,
        reason: correctionForm.reason.trim(),
        idempotencyKey: correctionKey.current,
      });
      correctionKey.current = newIdempotencyKey();
      closeExpanded();
      void queryClient.invalidateQueries({
        queryKey: ["service-visit-report"],
      });
    } catch (cause) {
      setCorrectionError(errorMessage(cause, "Could not correct this visit."));
    } finally {
      setCorrectionSaving(false);
    }
  }

  const rawRows = useMemo(() => visitsQuery.data ?? [], [visitsQuery.data]);

  const clientLocationMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of clientLocationsQuery.data ?? []) {
      const location = [client.address_city, client.address_state]
        .filter(Boolean)
        .join(", ");
      map.set(client.id, location || "Location not set");
    }
    return map;
  }, [clientLocationsQuery.data]);

  const rows = useMemo(
    () =>
      locationFilter
        ? rawRows.filter(
            (row) => clientLocationMap.get(row.client_id) === locationFilter,
          )
        : rawRows,
    [clientLocationMap, locationFilter, rawRows],
  );

  const locationOptions = useMemo(
    () => Array.from(new Set(clientLocationMap.values())).sort(),
    [clientLocationMap],
  );

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) =>
      map.set(row.client_id, visitClientLabel(row)),
    );
    return Array.from(map.entries());
  }, [rows]);

  const caregiverOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => map.set(row.caregiver_user_id, row.caregiver_name));
    return Array.from(map.entries());
  }, [rows]);

  const selectedCaregiverName = useMemo(
    () => caregiverOptions.find(([id]) => id === caregiverFilter)?.[1] ?? null,
    [caregiverFilter, caregiverOptions],
  );

  function selectCaregiverFolder(caregiverId: string) {
    setCaregiverFilter(caregiverId);
    const url = new URL(window.location.href);
    if (caregiverId) url.searchParams.set("caregiver", caregiverId);
    else url.searchParams.delete("caregiver");
    window.history.replaceState({}, "", url);
  }

  const serviceOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => map.set(row.service_id, row.service_name));
    return Array.from(map.entries());
  }, [rows]);

  const selectedClientName = useMemo(
    () => clientOptions.find(([id]) => id === clientFilter)?.[1] ?? null,
    [clientFilter, clientOptions],
  );
  // The client code, shown next to a legal name (office printouts only).
  const selectedClientCode = useMemo(() => {
    const row = rows.find((r) => r.client_id === clientFilter);
    return row && row.client_legal_name ? row.client_code : null;
  }, [clientFilter, rows]);
  const selectedServiceName = useMemo(
    () => serviceOptions.find(([id]) => id === serviceFilter)?.[1] ?? null,
    [serviceFilter, serviceOptions],
  );

  const showBalanceDetails = BALANCE_COLUMNS.every((key) => !visitColumns.has(key));
  const visibleVisitColumnCount = visitColumns.size + (showBalanceDetails ? 1 : 0) + (canManage ? 1 : 0);

  const visibleVisitRows = useMemo(
    () =>
      showSuperseded
        ? rows
        : rows.filter((row) => row.status !== "corrected"),
    [rows, showSuperseded],
  );

  const monthlyServiceRows = useMemo(
    () =>
      (monthlyServiceSummaryQuery.data ?? []).filter(
        (row) => !serviceFilter || row.serviceId === serviceFilter,
      ),
    [monthlyServiceSummaryQuery.data, serviceFilter],
  );

  const correctionRows = useMemo(
    () => correctionHistoryReportQuery.data ?? [],
    [correctionHistoryReportQuery.data],
  );
  const correctedByOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of correctionRows) {
      map.set(row.correctedByUserId, row.correctedByName);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [correctionRows]);
  const correctionNetMinutes = correctionRows.reduce(
    (total, row) =>
      total + row.afterSnapshot.workedMinutes - row.beforeSnapshot.workedMinutes,
    0,
  );

  const billable = useMemo(() => billableRows(rows), [rows]);
  // The client calendar always covers the WHOLE month for the selected
  // client, independent of the caregiver/service/status/date filters, so its
  // day cells reconcile with the monthly service totals below it.
  const calendarMonthBounds = useMemo(() => {
    const [y, m] = reportMonth.split("-").map(Number);
    if (!y || !m) return null;
    const last = new Date(y, m, 0).getDate();
    return { from: `${reportMonth}-01`, to: `${reportMonth}-${String(last).padStart(2, "0")}` };
  }, [reportMonth]);
  const calendarVisitsQuery = useQuery({
    queryKey: ["service-visit-report-calendar", activeOrganizationId, clientFilter, reportMonth],
    queryFn: (): Promise<VisitReportRow[]> =>
      backend.listVisits(activeOrganizationId!, {
        clientId: clientFilter,
        caregiverUserId: null,
        serviceId: null,
        dateFrom: calendarMonthBounds!.from,
        dateTo: calendarMonthBounds!.to,
        status: null,
      }),
    enabled: !!activeOrganizationId && canRead && reportView === "calendar" && !!clientFilter && !!calendarMonthBounds,
  });
  const monthCalendar = useMemo(
    () => buildMonthCalendar(calendarVisitsQuery.data ?? [], reportMonth),
    [reportMonth, calendarVisitsQuery.data],
  );
  const [calendarDetailPage, setCalendarDetailPage] = useState(false);
  const clientMonth = useMemo(
    () =>
      buildClientMonthSummary(
        calendarVisitsQuery.data ?? [],
        reportMonth,
        monthlyServiceSummaryQuery.isSuccess ? monthlyServiceSummaryQuery.data : null,
      ),
    [calendarVisitsQuery.data, reportMonth, monthlyServiceSummaryQuery.isSuccess, monthlyServiceSummaryQuery.data],
  );
  const calendarMonthLabel = useMemo(() => {
    const [y, m] = reportMonth.split("-").map(Number);
    return y && m ? new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : reportMonth;
  }, [reportMonth]);
  const totalWorkedMinutes = sumMinutes(billable, "worked_minutes");
  const totalBillableMinutes = sumMinutes(billable, "billable_minutes");

  const caregiverSubtotals = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        workedMinutes: number;
        billableMinutes: number;
        visits: number;
      }
    >();
    for (const row of billable) {
      const entry = map.get(row.caregiver_user_id) ?? {
        name: row.caregiver_name,
        workedMinutes: 0,
        billableMinutes: 0,
        visits: 0,
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      entry.visits += 1;
      map.set(row.caregiver_user_id, entry);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.workedMinutes - a.workedMinutes,
    );
  }, [billable]);

  const clientSubtotals = useMemo(() => {
    const map = new Map<
      string,
      {
        code: string;
        legalName: string | null;
        workedMinutes: number;
        billableMinutes: number;
        visits: number;
      }
    >();
    for (const row of billable) {
      const entry = map.get(row.client_id) ?? {
        code: row.client_code,
        legalName: row.client_legal_name,
        workedMinutes: 0,
        billableMinutes: 0,
        visits: 0,
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      entry.visits += 1;
      map.set(row.client_id, entry);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.billableMinutes - a.billableMinutes,
    );
  }, [billable]);

  const clientServiceSubtotals = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        code: string;
        legalName: string | null;
        serviceName: string;
        workedMinutes: number;
        billableMinutes: number;
        visits: number;
      }
    >();
    for (const row of billable) {
      const key = `${row.client_id}:${row.service_id}`;
      const entry = map.get(key) ?? {
        key,
        code: row.client_code,
        legalName: row.client_legal_name,
        serviceName: row.service_name,
        workedMinutes: 0,
        billableMinutes: 0,
        visits: 0,
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      entry.visits += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        a.code.localeCompare(b.code) ||
        a.serviceName.localeCompare(b.serviceName),
    );
  }, [billable]);

  const chartData = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; workedMinutes: number; billableMinutes: number }
    >();
    for (const row of billable) {
      const name =
        chartGroup === "caregiver"
          ? row.caregiver_name
          : chartGroup === "client"
            ? (row.client_legal_name ?? row.client_code)
            : chartGroup === "service"
              ? row.service_name
              : (clientLocationMap.get(row.client_id) ?? "Location not set");
      const entry = grouped.get(name) ?? {
        name,
        workedMinutes: 0,
        billableMinutes: 0,
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      grouped.set(name, entry);
    }
    return Array.from(grouped.values()).sort(
      (a, b) => b.workedMinutes - a.workedMinutes,
    );
  }, [billable, chartGroup, clientLocationMap]);

  const trendData = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; workedMinutes: number; billableMinutes: number }
    >();
    for (const row of billable) {
      const entry = grouped.get(row.service_date) ?? {
        name: row.service_date,
        workedMinutes: 0,
        billableMinutes: 0,
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      grouped.set(row.service_date, entry);
    }
    return Array.from(grouped.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [billable]);

  // Exception visits: anything that needed a human to intervene, not
  // just the normal signed-and-done path. administrator_review means
  // the visit exceeded the client's authorization at signing time (see
  // 20260809042943's resulting_visit_status logic); a non-
  // within_authorization authorization_status can independently be true
  // of a signed visit too; is_corrected means someone already fixed a
  // mistake on it. Sourced from every visit in the current filter, not
  // just the billable ones - an exception is worth seeing regardless of
  // whether it ended up billable.
  const exceptionVisits = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.status === "administrator_review" ||
          row.is_corrected ||
          (row.authorization_status !== null &&
            row.authorization_status !== "within_authorization"),
      ),
    [rows],
  );

  // A link to ?correct=<visit> (from a visit's review page) opens that visit's correction once.
  const correctFromUrl = new URLSearchParams(location.search).get("correct");
  const openedFromUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!correctFromUrl || openedFromUrl.current === correctFromUrl) return;
    const row = rows.find((r) => r.id === correctFromUrl);
    if (row && (row.status === "signed" || row.status === "administrator_review")) {
      openedFromUrl.current = correctFromUrl;
      openCorrect(row);
    }
    // openCorrect only reads the row it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctFromUrl, rows]);

  function openClose(row: VisitReportRow) {
    setCloseError(null);
    // Only the date is pre-filled: the actual end time must be entered, not
    // assumed from the schedule.
    setCloseForm({
      visitId: row.id,
      timeIn: row.time_in,
      timeOut: { date: toPacificWallTime(row.time_in).date, hour: null, minute: null, meridiem: null },
      reason: "",
    });
  }

  async function handleSubmitClose() {
    if (!closeForm) return;
    setCloseError(null);
    if (!closeForm.reason.trim()) {
      setCloseError("A reason is required to close a missed visit.");
      return;
    }
    const parsed = pacificWallTimeToDate(closeForm.timeOut);
    if (!parsed.ok) {
      setCloseError(parsed.error);
      return;
    }
    const timeOut = parsed.value;
    const invalid = validateManagerTimeOut(closeForm.timeIn, timeOut);
    if (invalid) {
      setCloseError(invalid);
      return;
    }
    setCloseSaving(true);
    try {
      await backend.closeMissedVisit({
        visitId: closeForm.visitId,
        timeOut: timeOut.toISOString(),
        reason: closeForm.reason.trim(),
        idempotencyKey: closeKey.current,
      });
      closeKey.current = newIdempotencyKey();
      setCloseForm(null);
      void queryClient.invalidateQueries({ queryKey: ["service-visit-report"] });
    } catch (cause) {
      setCloseError(errorMessage(cause, "Could not close this visit."));
    } finally {
      setCloseSaving(false);
    }
  }

  // Missed clock-outs and visits never confirmed (classifyIncompleteVisit),
  // most overdue first. In-progress visits inside their shift are not listed.
  const incompleteVisits = useMemo(() => {
    const now = new Date();
    return rows
      .map((row) => ({ row, issue: classifyIncompleteVisit(row, now) }))
      .filter((x): x is { row: VisitReportRow; issue: NonNullable<typeof x.issue> } => x.issue !== null)
      .sort((a, b) => overdueMinutes(b.issue) - overdueMinutes(a.issue));
  }, [rows]);

  function handlePrint() {
    window.print();
  }

  const activeFilterCount = [clientFilter, caregiverFilter, serviceFilter, statusFilter, correctedByFilter, locationFilter]
    .filter(Boolean).length;

  function resetFilters() {
    setClientFilter("");
    setServiceFilter("");
    setStatusFilter("");
    setCorrectedByFilter("");
    setLocationFilter("");
    if (caregiverFilter) selectCaregiverFolder("");
  }

  function applyDatePreset(preset: DatePreset) {
    setDatePreset(preset);
    if (preset === "custom") return;
    const range = presetRange(preset);
    setDateFrom(range.from);
    setDateTo(range.to);
  }

  async function copyStaffLink() {
    await navigator.clipboard.writeText(
      `${window.location.origin}/service-verification`,
    );
    setLinkCopied(true);
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">
            Service Verification
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            Not available
          </h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view service verification reports.
          </p>
        </Card>
      </section>
    );
  }

  const letterhead = letterheadQuery.data;

  // Running print header and page numbers: the browser repeats these on EVERY printed page (CSS page
  // margin boxes), so a page that is separated from the first one still names the agency, report,
  // client and period. Values go into a CSS string, so quotes, backslashes and control characters are removed.
  const printReportTitle =
    reportView === "calendar" ? "Client Monthly Service Calendar"
    : reportView === "reconciliation" ? "Monthly Hours & Billing"
    : reportView === "corrections" ? "Correction History"
    : "Service Verification Report";
  const printPeriod =
    reportView === "calendar" || reportView === "reconciliation"
      ? calendarMonthLabel
      : dateFrom || dateTo
        ? `${dateFrom || "start"} to ${dateTo || "today"}`
        : "All dates";
  const printRunningHeader = [
    letterhead?.legal_name ?? activeOrganization?.displayName ?? "",
    printReportTitle,
    `Client: ${selectedClientName ? `${selectedClientName}${selectedClientCode ? ` (${selectedClientCode})` : ""}` : "All clients"}`,
    `${reportView === "calendar" || reportView === "reconciliation" ? "Month" : "Period"}: ${printPeriod}`,
    environmentMarker?.label ?? "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  const printRunningHeaderCss = Array.from(printRunningHeader, (ch) => (ch.charCodeAt(0) < 32 || ch === '"' || ch === "\\" ? " " : ch)).join("");

  // Shared by the desktop table row and the phone card (only one layout renders).
  function renderCorrectionPanel(row: VisitReportRow) {
    return (
      <>
                                <p className="text-sm font-semibold text-slate-900">Correct this visit</p>
                                <p className="mt-1 text-xs text-slate-500">
                                  The signed record is never overwritten. The correction creates a
                                  linked revision and preserves the original in History.
                                </p>
                                <div className="mt-3 space-y-3">
                                  <PacificCorrectionFields
                                    originalTimeIn={correctionForm.originalTimeIn}
                                    originalTimeOut={correctionForm.originalTimeOut}
                                    timeIn={correctionForm.timeIn}
                                    timeOut={correctionForm.timeOut}
                                    onTimeInChange={(timeIn) => {
                                      setCorrectionError(null);
                                      setCorrectionForm({ ...correctionForm, timeIn });
                                    }}
                                    onTimeOutChange={(timeOut) => {
                                      setCorrectionError(null);
                                      setCorrectionForm({ ...correctionForm, timeOut });
                                    }}
                                  />
                                  <div>
                                    <label htmlFor="correction-reason" className="block text-xs font-medium text-slate-600">
                                      Reason (required)
                                    </label>
                                    <input
                                      id="correction-reason"
                                      required
                                      value={correctionForm.reason}
                                      onChange={(event) =>
                                        setCorrectionForm({ ...correctionForm, reason: event.target.value })
                                      }
                                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                                    />
                                  </div>
                                </div>
                                {correctionError ? (
                                  <p role="alert" className="mt-2 text-sm font-medium text-red-700">
                                    {correctionError}
                                  </p>
                                ) : null}
                                <div className="mt-3 flex gap-3">
                                  <Button type="button" loading={correctionSaving} onClick={() => handleSubmitCorrection(row.id)}>
                                    {correctionSaving ? "Saving…" : "Save correction"}
                                  </Button>
                                  <button type="button" onClick={closeExpanded} className="text-sm font-medium text-slate-600 hover:text-slate-900">
                                    Cancel
                                  </button>
                                </div>
      </>
    );
  }

  function renderHistoryPanel() {
    return (
      <>
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-semibold text-slate-900">Correction history</p>
                                  <button type="button" onClick={closeExpanded} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                                    Close
                                  </button>
                                </div>
                                {correctionsQuery.isLoading ? (
                                  <p className="mt-2 text-sm text-slate-500">Loading…</p>
                                ) : (correctionsQuery.data ?? []).length === 0 ? (
                                  <p className="mt-2 text-sm text-slate-500">No corrections recorded for this visit.</p>
                                ) : (
                                  <ul className="mt-2 space-y-2">
                                    {(correctionsQuery.data ?? []).map((entry, index) => (
                                      <li key={entry.id} className="rounded-lg border border-slate-200 bg-og-card p-3 text-sm">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <p className="font-medium text-slate-900">
                                            Revision {index + 1} · {entry.corrected_by_name}
                                          </p>
                                          <p className="text-xs text-slate-500">{formatDateTime(entry.created_at)}</p>
                                        </div>
                                        <p className="mt-1 text-slate-600">Reason: {entry.reason}</p>
                                        <p className="mt-1 text-xs text-slate-500">
                                          {formatTimeRange(entry.before_snapshot.timeIn, entry.before_snapshot.timeOut)}
                                          {" "}({formatDuration(entry.before_snapshot.workedMinutes)})
                                          {" "}→{" "}
                                          {formatTimeRange(entry.after_snapshot.timeIn, entry.after_snapshot.timeOut)}
                                          {" "}({formatDuration(entry.after_snapshot.workedMinutes)})
                                        </p>
                                      </li>
                                    ))}
                                  </ul>
                                )}
      </>
    );
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-12 print:max-w-none print:space-y-2 print:pb-0">
      <div className="print:hidden">
        <PageHeader
          eyebrow="Service Verification"
          title={reportView === "visits" ? "Visit records" : reportView === "exceptions" ? "Action needed" : "Reports"}
          {...(reportView === "calendar" ? { description: "The calendar always covers the chosen client's whole month." } : {})}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={handlePrint}>
                Print / Save as PDF
              </Button>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-lg border border-slate-300 bg-og-card px-3 py-2 text-sm font-medium text-slate-700">
                More actions
              </summary>
              <div className="absolute right-0 z-20 mt-2 flex w-64 flex-col gap-2 rounded-xl border border-slate-200 bg-og-card p-3 shadow-lg">
              {canManage ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={
                    linkCopied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )
                  }
                  onClick={copyStaffLink}
                >
                  {linkCopied ? "Staff link copied" : "Copy staff sign-in link"}
                </Button>
              ) : null}
              </div>
            </details>
            </div>
          }
        />
      </div>

      <Card className="print:hidden">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-64 flex-1">
            <label htmlFor="report-view" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
              Report
            </label>
            <select
              id="report-view"
              value={reportView}
              onChange={(event) => {
                const next = event.target.value as ReportView;
                setReportView(next);
                // Keep the address (and so the sidebar highlight) in step with the selection.
                const params = new URLSearchParams(location.search);
                if (next === defaultView) params.delete("view");
                else params.set("view", next);
                const search = params.toString();
                navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
                closeExpanded();
              }}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-og-card px-3 py-2.5 text-sm font-semibold text-slate-950"
            >
              <option value="visits">Visit records</option>
              <option value="exceptions">Action needed</option>
              <option value="overview">Visits overview</option>
              <option value="caregiver">Caregiver hours</option>
              <option value="calendar">Client monthly calendar</option>
              {viewAvailable("reconciliation") ? <option value="reconciliation">Monthly hours & billing</option> : null}
              {viewAvailable("corrections") ? <option value="corrections">Correction history</option> : null}
              {canManage ? <option value="staff-access">Staff access</option> : null}
            </select>
          </div>
        </div>
      </Card>

      {canManage && reportView === "staff-access" ? (
        <Card className="border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-sky-50 print:hidden">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <ShieldCheck className="h-6 w-6" />
            </span>
            <div>
              <h3 className="font-bold text-emerald-950">
                One secure staff link
              </h3>
              <p className="mt-1 text-sm text-emerald-900">
                Send the same link to every caregiver. Each person signs in with
                their own account and can only see clients and services assigned
                to them. For an extra shift, a manager assigns that client and
                service first; managers can correct a submitted visit when a
                mistake is made.
              </p>
              <a
                href="/clients"
                className="mt-3 inline-flex rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-800"
              >
                Manage client assignments
              </a>
            </div>
          </div>
        </Card>
      ) : null}

      {reportView === "caregiver" ? (
        <Card className="print:hidden">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">
                Caregiver folders
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Open a caregiver folder to view, print, or bookmark only that
                caregiver&apos;s sheets.
              </p>
            </div>
            {caregiverFilter ? (
              <button
                type="button"
                onClick={() => selectCaregiverFolder("")}
                className="text-sm font-semibold text-sky-700 underline"
              >
                All caregivers
              </button>
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {caregiverOptions.map(([id, name]) => (
              <button
                key={id}
                type="button"
                onClick={() => selectCaregiverFolder(id)}
                className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 text-left hover:border-sky-400 hover:bg-sky-50"
              >
                <Folder className="h-6 w-6 text-sky-700" />
                <span>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Caregiver
                  </span>
                  <span className="block font-semibold text-slate-950">
                    {name}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      <style>{`@media print { @page { ${reportView === "visits" ? "size: letter landscape; " : ""}margin: 0.5in; @top-left { content: "${printRunningHeaderCss}"; font: 8pt sans-serif; color: #334155; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #334155; } } }`}</style>
      {/* The date range and filters do not apply to the client calendar (it is always one client, one full month), so they are not shown there. */}
      {reportView !== "staff-access" && reportView !== "calendar" ? (
        <Card className="print:hidden">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="report-date-range" className="block text-xs font-medium text-slate-600">
                Date range
              </label>
              <select
                id="report-date-range"
                value={datePreset}
                onChange={(event) => applyDatePreset(event.target.value as DatePreset)}
                className="mt-1 rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm text-slate-900"
              >
                {DATE_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            {datePreset === "custom" ? (
              <>
                <div>
                  <label htmlFor="report-from" className="block text-xs font-medium text-slate-600">From</label>
                  <input
                    id="report-from"
                    type="date"
                    value={dateFrom}
                    max={dateTo || undefined}
                    onChange={(event) => setDateFrom(event.target.value)}
                    className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="report-to" className="block text-xs font-medium text-slate-600">To</label>
                  <input
                    id="report-to"
                    type="date"
                    value={dateTo}
                    min={dateFrom || undefined}
                    onChange={(event) => setDateTo(event.target.value)}
                    className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
              </>
            ) : null}
          </div>
          {datePreset === "custom" && dateFrom && dateTo && dateFrom > dateTo ? (
            <p role="alert" className="mt-2 text-sm text-red-700">From must be on or before To.</p>
          ) : null}
          <details className="mt-3" open={!narrow}>
            <summary className="cursor-pointer text-sm font-medium text-slate-800">
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}
            </summary>
            {activeFilterCount > 0 ? (
              <button type="button" onClick={resetFilters} className="mt-2 text-xs font-medium text-sky-700 underline">
                Clear filters
              </button>
            ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label
                htmlFor="report-client"
                className="block text-xs font-medium text-slate-600"
              >
                Client
              </label>
              <select
                id="report-client"
                value={clientFilter}
                onChange={(event) => setClientFilter(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">All clients</option>
                {clientOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="report-location"
                className="block text-xs font-medium text-slate-600"
              >
                Location
              </label>
              <select
                id="report-location"
                value={locationFilter}
                onChange={(event) => setLocationFilter(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">All locations</option>
                {locationOptions.map((location) => (
                  <option key={location} value={location}>
                    {location}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="report-caregiver"
                className="block text-xs font-medium text-slate-600"
              >
                Caregiver
              </label>
              <select
                id="report-caregiver"
                value={caregiverFilter}
                onChange={(event) => selectCaregiverFolder(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">All caregivers</option>
                {caregiverOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="report-service"
                className="block text-xs font-medium text-slate-600"
              >
                Service
              </label>
              <select
                id="report-service"
                value={serviceFilter}
                onChange={(event) => setServiceFilter(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">All services</option>
                {serviceOptions.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="report-status"
                className="block text-xs font-medium text-slate-600"
              >
                Status
              </label>
              <select
                id="report-status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">All statuses</option>
                {Object.entries(VISIT_STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {reportView === "corrections" ? (
              <div>
                <label
                  htmlFor="report-corrected-by"
                  className="block text-xs font-medium text-slate-600"
                >
                  Corrected by
                </label>
                <select
                  id="report-corrected-by"
                  value={correctedByFilter}
                  onChange={(event) => setCorrectedByFilter(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                >
                  <option value="">All correctors</option>
                  {correctedByOptions.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          </details>
          <details className="mt-3 text-xs text-slate-500">
            <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">Details</summary>
            <p>Use Custom for a pay period or any other range. These reports use actual signed visit time, not the schedule.</p>
          </details>
        </Card>
      ) : null}

      {reportView === "overview" ? (
        <>
          {awsApi ? <p className="text-sm text-slate-700" data-testid="reporting-hub-link">More reports: <Link className="font-semibold underline" to="/reporting">Reporting &amp; billing</Link>.</p> : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Worked hours",
                value: formatDuration(totalWorkedMinutes),
                icon: <BarChart3 className="h-5 w-5" />,
                color: "bg-indigo-50 text-indigo-800 border-indigo-100",
              },
              {
                label: "Billable hours",
                value: formatDuration(totalBillableMinutes),
                icon: <Check className="h-5 w-5" />,
                color: "bg-emerald-50 text-emerald-800 border-emerald-100",
              },
              {
                label: "Caregivers",
                value: String(caregiverSubtotals.length),
                icon: <Users className="h-5 w-5" />,
                color: "bg-sky-50 text-sky-800 border-sky-100",
              },
              {
                label: "Clients",
                value: String(clientSubtotals.length),
                icon: <MapPin className="h-5 w-5" />,
                color: "bg-violet-50 text-violet-800 border-violet-100",
              },
            ].map((metric) => (
              <Card key={metric.label} className={`border ${metric.color}`}>
                <div className="flex items-center justify-between">
                  <span>{metric.icon}</span>
                  <span className="text-3xl font-extrabold tabular-nums">
                    {metric.value}
                  </span>
                </div>
                <p className="mt-2 text-sm font-bold">{metric.label}</p>
              </Card>
            ))}
          </div>

          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="font-bold text-slate-950">Hours chart</h3>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="text-xs font-semibold text-slate-600">
                  Chart
                  <select
                    aria-label="Chart type"
                    value={chartType}
                    onChange={(event) =>
                      setChartType(event.target.value as ChartType)
                    }
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900"
                  >
                    <option value="bar">Bar</option>
                    <option value="pie">Pie</option>
                    <option value="line">Daily trend</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-600">
                  Group by
                  <select
                    aria-label="Group chart by"
                    value={chartGroup}
                    disabled={chartType === "line"}
                    onChange={(event) =>
                      setChartGroup(event.target.value as ChartGroup)
                    }
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-100"
                  >
                    <option value="caregiver">Caregiver</option>
                    <option value="client">Client</option>
                    <option value="service">Service</option>
                    <option value="location">Location</option>
                  </select>
                </label>
              </div>
            </div>
            {chartData.length === 0 ? (
              <p className="mt-6 rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">
                No signed visit hours match these filters.
              </p>
            ) : (
              <div className="mt-5 h-80" aria-label="Filtered hours chart">
                <ResponsiveContainer width="100%" height="100%">
                  {chartType === "pie" ? (
                    <PieChart>
                      <Pie
                        data={chartData}
                        dataKey="workedMinutes"
                        nameKey="name"
                        outerRadius={105}
                        label={({ name, value }) =>
                          `${name}: ${formatDuration(Number(value))}`
                        }
                      >
                        {chartData.map((entry, index) => (
                          <Cell
                            key={entry.name}
                            fill={CHART_COLORS[index % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatDuration(Number(value))} />
                      <Legend />
                    </PieChart>
                  ) : chartType === "line" ? (
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={(value) => formatDuration(Number(value))} />
                      <Tooltip formatter={(value) => formatDuration(Number(value))} />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="workedMinutes"
                        name="Worked hours"
                        stroke="#4f46e5"
                        strokeWidth={3}
                      />
                      <Line
                        type="monotone"
                        dataKey="billableMinutes"
                        name="Billable hours"
                        stroke="#059669"
                        strokeWidth={3}
                      />
                    </LineChart>
                  ) : (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={(value) => formatDuration(Number(value))} />
                      <Tooltip formatter={(value) => formatDuration(Number(value))} />
                      <Legend />
                      <Bar
                        dataKey="workedMinutes"
                        name="Worked hours"
                        fill="#4f46e5"
                        radius={[6, 6, 0, 0]}
                      />
                      <Bar
                        dataKey="billableMinutes"
                        name="Billable hours"
                        fill="#059669"
                        radius={[6, 6, 0, 0]}
                      />
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </>
      ) : null}

      {reportView === "caregiver" ? (
        <Card>
          <h3 className="font-bold text-slate-950">
            Caregiver hours — {selectedClientName ?? "all clients"}
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            {selectedServiceName ?? "All services combined"} · selected date
            range
          </p>
          {caregiverSubtotals.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No caregiver hours match these filters.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table
                aria-label="Caregiver hours summary"
                className="w-full text-left text-sm"
              >
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-medium">Caregiver</th>
                    <th className="pb-2 font-medium">Worked</th>
                    <th className="pb-2 font-medium">Billable</th>
                    <th className="pb-2 font-medium">Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {caregiverSubtotals.map((entry) => (
                    <tr key={entry.name} className="border-b border-slate-100">
                      <td className="py-2 font-semibold text-slate-900">
                        {entry.name}
                      </td>
                      <td className="py-2 text-indigo-700">
                        {formatDuration(entry.workedMinutes)}
                      </td>
                      <td className="py-2 text-emerald-700">
                        {formatDuration(entry.billableMinutes)}
                      </td>
                      <td className="py-2 text-slate-600">{entry.visits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {/* Letterhead - shown only when printing, built from this organization's
          own settings so a re-branded/white-labeled tenant prints correctly
          instead of hardcoded agency details. */}
      <div className="hidden print:block">
        <div className={`flex items-start justify-between border-b border-slate-300 ${reportView === "calendar" ? "pb-1 text-[10px] leading-tight" : "pb-4"}`}>
          <div>
            {letterhead?.logo_url ? (
              <img
                src={letterhead.logo_url}
                alt={letterhead.display_name}
                className={reportView === "calendar" ? "mb-1 max-h-9" : "mb-2 max-h-14"}
              />
            ) : null}
            <p className={reportView === "calendar" ? "text-sm font-semibold" : "text-lg font-semibold"}>
              {letterhead?.legal_name ?? activeOrganization?.displayName}
            </p>
            {letterhead?.address_street ? (
              <p className="text-sm">
                {letterhead.address_street}, {letterhead.address_city},{" "}
                {letterhead.address_state} {letterhead.address_zip}
              </p>
            ) : null}
            <p className="text-sm">
              {[letterhead?.contact_phone, letterhead?.contact_email]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className={`text-right text-slate-600 ${reportView === "calendar" ? "text-[10px] leading-tight" : "text-sm"}`}>
            <p className="font-semibold">
              {reportView === "calendar"
                ? "Client Monthly Service Calendar"
                : reportView === "reconciliation"
                  ? "Monthly Hours & Billing"
                  : reportView === "corrections"
                    ? "Correction History"
                    : "Service Verification Report"}
            </p>
            {selectedClientName ? <p>Client: {selectedClientName}{selectedClientCode ? ` (${selectedClientCode})` : ""}</p> : null}
            {selectedCaregiverName && reportView !== "calendar" ? <p>Caregiver: {selectedCaregiverName}</p> : null}
            {reportView === "calendar" || reportView === "reconciliation" ? (
              <p>Month: {calendarMonthLabel}</p>
            ) : null}
            <p>Printed: {formatDateTime(new Date())}</p>
            {environmentMarker?.label ? <p className="font-bold text-slate-900">{environmentMarker.label}</p> : null}
          </div>
        </div>
      </div>

      {reportView === "calendar" ? (
        <Card className="print:border-none print:p-0 print:shadow-none">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 h-5 w-5 text-sky-700 print:hidden" />
              <div>
                <h3 className="font-semibold text-slate-950 print:hidden">
                  Client monthly service calendar
                </h3>
                <p className="mt-1 text-sm text-slate-500 print:hidden">
                  Each date shows worked time per service, added up across caregivers.
                  Different services are never combined.
                </p>
                <p className="mt-1 text-xs text-slate-500 print:mt-0 print:text-[9px] print:text-slate-700">
                  Includes confirmed visits and visits in review (shaded amber). Replaced
                  originals and voided visits are left out, so corrections are not counted
                  twice. Visits not yet complete are listed separately and not counted.
                  <span className="print:hidden"> Always the full month for this client: the caregiver, service,
                  status and date filters do not apply here.</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2 print:hidden">
              <style>{"@media print { @page { size: letter landscape; margin: 0.4in; } }"}</style>
              <label className="text-xs font-medium text-slate-600">
                Calendar client
                <select
                  value={clientFilter}
                  onChange={(event) => setClientFilter(event.target.value)}
                  className="mt-1 block max-w-56 rounded-lg border border-slate-200 bg-og-card px-3 py-2 text-sm text-slate-900"
                >
                  <option value="">Choose a client…</option>
                  {clientOptions.map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Calendar month
                <input
                  type="month"
                  aria-label="Calendar month"
                  value={reportMonth}
                  onChange={(event) => setReportMonth(event.target.value)}
                  className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </label>
              <label className="flex items-center gap-2 self-center text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={calendarDetailPage}
                  onChange={(event) => setCalendarDetailPage(event.target.checked)}
                />
                Add a visit detail page
              </label>
              <Button
                type="button"
                icon={<Printer className="h-4 w-4" />}
                disabled={!clientFilter}
                onClick={handlePrint}
              >
                Print calendar / Save as PDF
              </Button>
              {canExport && clientFilter && monthlyServiceRows.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  onClick={() =>
                    downloadCsv(
                      `client-service-calendar-${reportMonth}.csv`,
                      [
                        ...clientCsvHeader(monthlyServiceRows),
                        "Service",
                        "Authorization period",
                        "Authorized",
                        "Worked",
                        "Confirmed",
                        "Billable",
                        "Rounding",
                        "Pending",
                        "Reserved",
                        "Hours left or Over limit",
                        "Authorization status",
                        "Needs review",
                      ],
                      monthlyServiceRows.map((row) => [
                        ...clientCsvCells(monthlyServiceRows, row),
                        `${row.serviceCode} ${row.serviceName}`,
                        `${formatDateOnly(row.authorizationPeriodStart)} to ${formatDateOnly(row.authorizationPeriodEnd)}`,
                        formatDuration(row.authorizedMinutes),
                        formatDuration(row.workedMinutes),
                        formatDuration(row.verifiedMinutes),
                        formatDuration(row.billableMinutes),
                        formatSignedDuration(row.hoursRoundingMinutes ?? row.adjustmentMinutes ?? 0),
                        formatDuration(row.hoursPendingMinutes ?? 0),
                        formatDuration(row.hoursReservedMinutes ?? row.reservedMinutes ?? 0),
                        hoursLeftText(row.hoursLeftMinutes ?? row.remainingMinutes),
                        authorizationStatus(row),
                        formatDuration(row.reviewMinutes),
                      ]),
                    )
                  }
                >
                  CSV
                </Button>
              ) : null}
            </div>
          </div>

          {!clientFilter ? (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              Choose a client to see its calendar.
            </div>
          ) : (
            <>
              <div className="mt-4 border-b border-slate-200 pb-3 print:hidden">
                <p className="font-semibold text-slate-950">
                  {selectedClientName ?? "Selected client"}
                  {selectedClientCode ? <span className="ml-1 text-sm font-normal text-slate-500">({selectedClientCode})</span> : null}
                  {" "}· {calendarMonthLabel}
                </p>
                {calendarVisitsQuery.isError ? (
                  <p role="alert" className="mt-1 text-sm text-red-700">Could not load this month's visits.</p>
                ) : null}
              </div>
              <div className="mt-4 overflow-x-auto print:mt-1 print:overflow-visible">
                <div
                  role="grid"
                  aria-label={`Service hours for ${selectedClientName ?? "selected client"} in ${reportMonth}`}
                  className="min-w-[760px] print:min-w-0"
                >
                  <div
                    role="row"
                    className="grid grid-cols-7 border-b border-slate-200 bg-slate-50"
                  >
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                      (day) => (
                        <div
                          key={day}
                          role="columnheader"
                          className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 print:py-0.5 print:text-[9px]"
                        >
                          {day}
                        </div>
                      ),
                    )}
                  </div>
                  {monthCalendar.weeks.map((week, weekIndex) => (
                    <div key={weekIndex} role="row" className="grid grid-cols-7">
                      {week.map((day, dayIndex) => {
                        const date = day
                          ? `${reportMonth}-${String(day).padStart(2, "0")}`
                          : null;
                        const entries = date
                          ? (monthCalendar.entries.get(date) ?? [])
                          : [];
                        return (
                          <div
                            key={`${weekIndex}-${dayIndex}`}
                            role="gridcell"
                            aria-label={date ?? "Outside selected month"}
                            className="min-h-28 border-b border-r border-slate-100 p-2 last:border-r-0 print:min-h-[0.56in] print:break-inside-avoid print:p-1"
                          >
                            {day ? (
                              <p className="text-xs font-semibold text-slate-600 print:text-[9px]">
                                {day}
                              </p>
                            ) : null}
                            <div className="mt-1 space-y-1.5 print:mt-0 print:space-y-0.5">
                              {entries.map((entry) => (
                                <div
                                  key={entry.key}
                                  className={
                                    entry.needsReview
                                      ? "rounded-md bg-amber-50 px-1.5 py-1 print:px-1 print:py-0"
                                      : "rounded-md bg-sky-50 px-1.5 py-1 print:px-1 print:py-0"
                                  }
                                >
                                  <p
                                    className="break-words text-[11px] font-semibold leading-tight text-slate-800 print:text-[8px]"
                                    title={entry.serviceName}
                                  >
                                    {entry.serviceName}
                                  </p>
                                  <p className="text-[11px] font-medium tabular-nums text-slate-700 print:text-[9px]">
                                    {formatDuration(entry.workedMinutes)}
                                  </p>
                                  {entry.billableMinutes !== entry.workedMinutes ? (
                                    <p className="text-[10px] tabular-nums text-slate-500 print:text-[8px]">
                                      Billable {formatDuration(entry.billableMinutes)}
                                    </p>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <CalendarSummary
                summary={clientMonth}
                serviceRows={monthlyServiceSummaryQuery.data ?? []}
                serviceRowsState={monthlyServiceSummaryQuery.isLoading ? "loading" : monthlyServiceSummaryQuery.isError ? "error" : "ready"}
                visitsState={calendarVisitsQuery.isLoading ? "loading" : calendarVisitsQuery.isError ? "error" : "ready"}
                detailPage={calendarDetailPage}
              />
            </>
          )}
        </Card>
      ) : null}

      {exportError ? <p role="alert" className="text-sm text-red-700 print:hidden">{exportError}</p> : null}
      {exportNotice ? <p role="status" className="text-sm text-emerald-800 print:hidden">{exportNotice}</p> : null}
      {reportView === "reconciliation" ? (
        <Card className="print:border-none print:p-0 print:shadow-none">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-950">
                Monthly hours & billing
              </h3>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Each row is one client + service + authorization lineage.
                Services are never combined. Worked and billable time remain
                separate so documentation or authorization differences cannot
                be hidden by a client-level total.
              </p>
              <p className="mt-1 max-w-3xl text-xs text-slate-500">
                <strong>Billable (eligible)</strong> is confirmed time within the
                authorization; <strong>Approved</strong> is what a person approved
                for billing. Approval is not submission: Ogevia does not submit to
                payers or track submissions.{" "}
                <strong>Reserved</strong> is scheduled time not yet delivered (ahead, underway, or ended with no visit record and awaiting a person's decision); nothing is released automatically.
                <strong> Pending</strong> is worked time not yet billable (awaiting confirmation or in review) and the shift time held for it. Open Details on a row for the full equation:
                Authorized = Billable + Rounding + Pending + Reserved + Hours left, where Hours left below zero is shown as Over limit and is never offset against another authorization.
              </p>
              {backend.kind === "aws" ? (
                <p className="mt-1 text-xs print:hidden">
                  <Link className="font-medium text-slate-800 underline" to="/">
                    Agency-wide utilization by service is on Home
                  </Link>
                </p>
              ) : null}
            </div>
            <div className="flex items-end gap-2 print:hidden">
              <label className="text-xs font-medium text-slate-600">
                Month
                <input
                  type="month"
                  value={reportMonth}
                  onChange={(event) => setReportMonth(event.target.value)}
                  className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                />
              </label>
              {canExport && monthlyServiceRows.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  onClick={() =>
                    downloadCsv(
                      `monthly-service-reconciliation-${reportMonth}.csv`,
                      [
                        ...clientCsvHeader(monthlyServiceRows),
                        "Service",
                        "Authorization period",
                        "Authorized",
                        "Worked",
                        "Verified",
                        "Billable (eligible)",
                        ...(showApproved ? ["Approved (human)", "Approved rounding adjustment"] : []),
                        "Rounding",
                        "Pending",
                        "Reserved",
                        "Hours left or Over limit",
                        "Authorization status",
                        "Needs review",
                        "Worked minus billable",
                        "Worked, not billable (hours accounting)",
                      ],
                      monthlyServiceRows.map((row) => [
                        ...clientCsvCells(monthlyServiceRows, row),
                        `${row.serviceCode} ${row.serviceName}`,
                        `${formatDateOnly(row.authorizationPeriodStart)} to ${formatDateOnly(row.authorizationPeriodEnd)}`,
                        formatDuration(row.authorizedMinutes),
                        formatDuration(row.workedMinutes),
                        formatDuration(row.verifiedMinutes),
                        formatDuration(row.billableMinutes),
                        ...(showApproved
                          ? [
                              formatDuration(approvedByLineage.get(row.authorizationLineageId)?.approvedMinutes ?? 0),
                              formatSignedDuration(approvedByLineage.get(row.authorizationLineageId)?.roundingAdjustmentMinutes ?? 0),
                            ]
                          : []),
                        formatSignedDuration(row.hoursRoundingMinutes ?? row.adjustmentMinutes ?? 0),
                        formatDuration(row.hoursPendingMinutes ?? 0),
                        formatDuration(row.hoursReservedMinutes ?? row.reservedMinutes ?? 0),
                        hoursLeftText(row.hoursLeftMinutes ?? row.remainingMinutes),
                        authorizationStatus(row),
                        formatDuration(row.reviewMinutes),
                        formatDuration(Math.max(0, row.workedMinutes - row.billableMinutes)),
                        formatDuration(row.hoursWorkedNotBillableMinutes ?? 0),
                      ]),
                    )
                  }
                >
                  CSV
                </Button>
              ) : null}
            </div>
          </div>

          {monthlyServiceSummaryQuery.isLoading ? (
            <p className="mt-4 text-sm text-slate-500">Loading reconciliation…</p>
          ) : monthlyServiceSummaryQuery.isError ? (
            <p className="mt-4 text-sm text-red-700">
              Could not load monthly reconciliation.
            </p>
          ) : monthlyServiceRows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No client/service authorizations match this month and filter.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="Monthly hours and billing reconciliation">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-3 font-medium">Client</th>
                    <th className="pb-2 pr-3 font-medium">Service</th>
                    <th className="pb-2 pr-3 font-medium">Authorized</th>
                    <th className="pb-2 pr-3 font-medium">Worked</th>
                    <th className="pb-2 pr-3 font-medium">Verified</th>
                    <th className="pb-2 pr-3 font-medium">Billable (eligible)</th>
                    {showApproved ? <th className="pb-2 pr-3 font-medium">Approved</th> : null}
                    <th className="pb-2 pr-3 font-medium">Rounding</th>
                    <th className="pb-2 pr-3 font-medium">Pending</th>
                    <th className="pb-2 pr-3 font-medium">Reserved</th>
                    <th className="pb-2 pr-3 font-medium">Hours left</th>
                    <th className="pb-2 pr-3 font-medium">Authorization status</th>
                    <th className="pb-2 pr-3 font-medium">Needs review</th>
                    <th className="pb-2 pr-3 font-medium">Difference</th>
                    <th className="pb-2 font-medium">Hours accounting</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyServiceRows.map((row) => {
                    const difference = Math.max(0, row.workedMinutes - row.billableMinutes);
                    return (
                      <tr key={row.authorizationLineageId} className="border-b border-slate-100">
                        <td className="py-2 pr-3"><ClientCell name={row.clientName} code={row.clientCode} duplicate={row.clientNameDuplicate} /></td>
                        <td className="py-2 pr-3">
                          <p className="font-medium text-slate-800">{row.serviceCode} · {row.serviceName}</p>
                          <p className="text-xs text-slate-500">
                            {formatDateOnly(row.authorizationPeriodStart)}–{formatDateOnly(row.authorizationPeriodEnd)}
                          </p>
                        </td>
                        <td className="py-2 pr-3">{formatDuration(row.authorizedMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.workedMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.verifiedMinutes)}</td>
                        <td className="py-2 pr-3 font-medium">{formatDuration(row.billableMinutes)}</td>
                        {showApproved ? (
                          <td className="py-2 pr-3">
                            {monthlyApprovalSummaryQuery.isError ? (
                              "Unable to load"
                            ) : monthlyApprovalSummaryQuery.isLoading ? (
                              "…"
                            ) : (
                              <>
                                {formatDuration(approvedByLineage.get(row.authorizationLineageId)?.approvedMinutes ?? 0)}
                                {approvedByLineage.get(row.authorizationLineageId)?.roundingAdjustmentMinutes ? (
                                  <span className="block text-xs text-slate-500">
                                    Rounding {formatSignedDuration(approvedByLineage.get(row.authorizationLineageId)!.roundingAdjustmentMinutes)}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </td>
                        ) : null}
                        <td className="py-2 pr-3">{formatSignedDuration(row.hoursRoundingMinutes ?? row.adjustmentMinutes ?? 0)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.hoursPendingMinutes ?? 0)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.hoursReservedMinutes ?? row.reservedMinutes ?? 0)}</td>
                        <td className={`py-2 pr-3 ${(row.hoursLeftMinutes ?? row.remainingMinutes) < 0 ? "font-semibold text-red-700" : ""}`}>{hoursLeftText(row.hoursLeftMinutes ?? row.remainingMinutes)}</td>
                        <td className="py-2 pr-3" data-testid="authorization-status">{authorizationStatus(row)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.reviewMinutes)}</td>
                        <td className="py-2 pr-3">
                          {difference > 0 ? (
                            <StatusBadge
                              label={`${formatDuration(difference)} worked not billable`}
                              tone="warning"
                            />
                          ) : (
                            <StatusBadge label="Matched" tone="success" />
                          )}
                        </td>
                        <td className="py-2"><HoursBreakdown row={row} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-slate-500">
            “Billable” means eligible to bill after visit verification and
            authorization controls. Actual submitted/billed totals will remain a
            separate ledger value; they must never be inferred from billable time.
          </p>
        </Card>
      ) : null}

      {reportView === "reconciliation" && awsApi && backend.kind === "aws" ? <MonthlyChainReport month={reportMonth} /> : null}

      {reportView === "corrections" ? (
        <Card className="print:border-none print:p-0 print:shadow-none">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-950">Correction history</h3>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Agency audit report of visit revisions. Original records remain
                immutable; this report shows who changed what, why, and when.
              </p>
            </div>
            {canExport && correctionRows.length > 0 ? (
              <Button
                type="button"
                variant="secondary"
                className="print:hidden"
                icon={<Download className="h-4 w-4" />}
                onClick={() =>
                  downloadCsv(
                    "correction-history.csv",
                    [
                      "Visit ref",
                      ...clientCsvHeader(correctionRows),
                      "Service",
                      "Service date",
                      "Caregiver",
                      "Original time",
                      "Corrected time",
                      "Original duration",
                      "Corrected duration",
                      "Corrected by",
                      "Status",
                      "Reason",
                      "Corrected on",
                    ],
                    correctionRows.map((row) => [
                      row.visitNumber,
                      ...clientCsvCells(correctionRows, row),
                      `${row.serviceCode} ${row.serviceName}`,
                      formatDateOnly(row.serviceDate),
                      row.caregiverName,
                      formatTimeRange(row.beforeSnapshot.timeIn, row.beforeSnapshot.timeOut),
                      formatTimeRange(row.afterSnapshot.timeIn, row.afterSnapshot.timeOut),
                      formatDuration(row.beforeSnapshot.workedMinutes),
                      formatDuration(row.afterSnapshot.workedMinutes),
                      row.correctedByName,
                      VISIT_STATUS_LABEL[row.correctedVisitStatus],
                      row.reason,
                      formatDateTime(row.createdAt),
                    ]),
                  )
                }
              >
                CSV
              </Button>
            ) : null}
          </div>
          {!correctionHistoryReportQuery.isLoading && !correctionHistoryReportQuery.isError ? (
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <span className="rounded-lg bg-slate-100 px-3 py-2 font-semibold text-slate-700">
                Corrections: {correctionRows.length}
              </span>
              <span className="rounded-lg bg-slate-100 px-3 py-2 font-semibold text-slate-700">
                Net worked-time change: {correctionNetMinutes === 0
                  ? "No change"
                  : `${correctionNetMinutes > 0 ? "+" : "−"}${formatDuration(Math.abs(correctionNetMinutes))}`}
              </span>
            </div>
          ) : null}
          {correctionHistoryReportQuery.isLoading ? (
            <p className="mt-4 text-sm text-slate-500">Loading correction history…</p>
          ) : correctionHistoryReportQuery.isError ? (
            <p className="mt-4 text-sm text-red-700">Could not load correction history.</p>
          ) : correctionRows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No corrections match these filters.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="Correction history report">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-3 font-medium">Visit ref</th>
                    <th className="pb-2 pr-3 font-medium">Client</th>
                    <th className="pb-2 pr-3 font-medium">Service</th>
                    <th className="pb-2 pr-3 font-medium">Date</th>
                    <th className="pb-2 pr-3 font-medium">Caregiver</th>
                    <th className="pb-2 pr-3 font-medium">Original</th>
                    <th className="pb-2 pr-3 font-medium">Corrected</th>
                    <th className="pb-2 pr-3 font-medium">Corrected by</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium">Reason</th>
                    <th className="pb-2 font-medium">Corrected on</th>
                  </tr>
                </thead>
                <tbody>
                  {correctionRows.map((row) => (
                    <tr key={row.correctionId} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs">{row.visitNumber ?? "—"}</td>
                      <td className="py-2 pr-3"><ClientCell name={row.clientName} code={row.clientCode} duplicate={row.clientNameDuplicate} /></td>
                      <td className="py-2 pr-3">{row.serviceCode} · {row.serviceName}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateOnly(row.serviceDate)}</td>
                      <td className="py-2 pr-3">{row.caregiverName}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatTimeRange(row.beforeSnapshot.timeIn, row.beforeSnapshot.timeOut)}
                        <span className="block text-xs text-slate-500">{formatDuration(row.beforeSnapshot.workedMinutes)}</span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatTimeRange(row.afterSnapshot.timeIn, row.afterSnapshot.timeOut)}
                        <span className="block text-xs text-slate-500">{formatDuration(row.afterSnapshot.workedMinutes)}</span>
                      </td>
                      <td className="py-2 pr-3">{row.correctedByName}</td>
                      <td className="py-2 pr-3">{VISIT_STATUS_LABEL[row.correctedVisitStatus]}</td>
                      <td className="py-2 pr-3">{row.reason}</td>
                      <td className="py-2 whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {reportView === "visits" ? (
        <>
          <Card className="print:border-none print:p-0 print:shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-sky-700" />
                <h3 className="font-semibold text-slate-950">
                  {selectedCaregiverName
                    ? `Caregiver ${selectedCaregiverName}`
                    : "Visits"}{" "}
                  ({visibleVisitRows.length})
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ShortHelp className="text-xs font-medium text-slate-600" details="A correction keeps the original visit and adds a replacement. Replaced shows those originals. Off by default.">
                  <label className="inline-flex min-h-[44px] items-center gap-2 md:min-h-[32px]">
                    <input
                      type="checkbox"
                      checked={showSuperseded}
                      onChange={(event) => setShowSuperseded(event.target.checked)}
                    />
                    Replaced
                  </label>
                </ShortHelp>
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded-lg border border-slate-300 bg-og-card px-3 py-2 text-xs font-semibold text-slate-700">
                    Columns
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-52 rounded-xl border border-slate-200 bg-og-card p-3 shadow-lg">
                    <div className="space-y-2">
                      {VISIT_COLUMN_OPTIONS.map((column) => (
                        <label key={column.key} className="flex items-center gap-2 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={visitColumns.has(column.key)}
                            onChange={() => toggleVisitColumn(column.key)}
                          />
                          {column.label}
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={resetVisitColumns}
                      className="mt-3 text-xs font-medium text-slate-600 underline"
                    >
                      Reset columns
                    </button>
                  </div>
                </details>
              </div>
            </div>
            {visitsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : visitsQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">
                Could not load service verification records.
              </p>
            ) : visibleVisitRows.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No visits match these filters.
              </p>
            ) : narrow ? (
              <>
                <ul aria-label="Visit records" className="mt-4 space-y-3">
                  {visibleVisitRows.map((row) => {
                    const authorizedMinutes =
                      row.month_to_date_after_minutes !== null && row.remaining_minutes !== null
                        ? row.month_to_date_after_minutes + row.remaining_minutes
                        : null;
                    const statusBadge =
                      row.status === "corrected" ? (
                        <StatusBadge label="Replaced by a correction" tone="neutral" />
                      ) : row.is_corrected && row.status === "signed" ? (
                        <StatusBadge label="Confirmed · Revised" tone="success" />
                      ) : (
                        <StatusBadge label={VISIT_STATUS_LABEL[row.status]} tone={STATUS_TONE[row.status]} />
                      );
                    return (
                      <li key={row.id} className="rounded-xl border border-slate-200 bg-og-card p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-950">{visitClientLabel(row)}</p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {statusBadge}
                            {row.time_out_entered_by_manager ? <StatusBadge label="Time Out entered by manager" tone="warning" /> : null}
                          </div>
                        </div>
                        <p className="mt-1 text-sm text-slate-700">
                          {formatDateOnly(row.service_date)} · <span className="font-mono">{formatTimeRange(row.time_in, row.time_out)}</span>
                        </p>
                        {canManage && backend.kind === "aws" && row.status === "administrator_review" ? (
                          <div className="mt-2 print:hidden">
                            <Link to={`/visits/${row.id}`} className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-600 px-4 text-sm font-medium text-amber-900">
                              Review
                            </Link>
                          </div>
                        ) : null}
                        <details className="mt-2 text-sm" open={expandedVisitId === row.id}>
                          <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-og-link underline">Details</summary>
                        <p className="text-sm text-slate-700">{row.caregiver_name} · {row.service_name}</p>
                        <p className="text-xs text-slate-500">
                          {row.scheduled_starts_at ? "Scheduled " : ""}
                          {formatScheduledWindow(row.scheduled_starts_at, row.scheduled_ends_at, row.caregiver_scheduling_mode)}
                        </p>
                        <p className="mt-1 text-sm font-medium text-slate-900">
                          Worked {formatDuration(row.worked_minutes)} · Billable {formatDuration(row.billable_minutes)}
                        </p>
                        <details className="mt-2 text-sm">
                          <summary className="cursor-pointer text-xs font-medium text-slate-600">Hours left</summary>
                          <dl className="mt-1 grid grid-cols-3 gap-2 text-xs">
                            <div><dt className="text-slate-500">Authorized</dt><dd className="font-medium text-slate-900">{formatDuration(authorizedMinutes)}</dd></div>
                            <div><dt className="text-slate-500">Billable this month</dt><dd className="font-medium text-slate-900">{formatDuration(row.month_to_date_after_minutes)}</dd></div>
                            <div><dt className="text-slate-500">Hours left</dt><dd className="font-medium text-slate-900">{formatBalance(row.remaining_minutes)}</dd></div>
                          </dl>
                        </details>
                        <p className="mt-2 font-mono text-[11px] text-slate-500">Visit {row.visit_number ?? "—"}{row.client_legal_name ? ` · Client ${row.client_code}` : ""}</p>
                        {canManage ? (
                          <div className="mt-2 flex flex-wrap gap-2 print:hidden">
                            {row.status === "signed" || row.status === "administrator_review" ? (
                              <button type="button" onClick={() => openCorrect(row)} className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800">
                                Correct
                              </button>
                            ) : null}
                            <button type="button" onClick={() => openHistory(row)} className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800">
                              History
                            </button>
                          </div>
                        ) : null}
                        {expandedVisitId === row.id && expandedMode === "correct" ? (
                          <div className="mt-3 rounded-lg bg-slate-50 p-3">{renderCorrectionPanel(row)}</div>
                        ) : null}
                        {expandedVisitId === row.id && expandedMode === "history" ? (
                          <div className="mt-3 rounded-lg bg-slate-50 p-3">{renderHistoryPanel()}</div>
                        ) : null}
                        </details>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-200 pt-3 text-sm font-medium text-slate-800">
                  <span>Worked: {formatDuration(totalWorkedMinutes)}</span>
                  <span>Billable: {formatDuration(totalBillableMinutes)}</span>
                </div>
              </>
            ) : (
              <div
                className="mt-4 overflow-x-auto print:overflow-visible"
                role="region"
                aria-label="Visit records table (scrolls sideways when the window is narrow)"
                tabIndex={0}
                style={{
                  background:
                    "linear-gradient(to right, #fff 30%, rgba(255,255,255,0)) 0 0 / 40px 100% no-repeat local, linear-gradient(to left, #fff 30%, rgba(255,255,255,0)) 100% 0 / 40px 100% no-repeat local, radial-gradient(farthest-side at 0 50%, rgba(15,36,48,0.22), rgba(15,36,48,0)) 0 0 / 14px 100% no-repeat scroll, radial-gradient(farthest-side at 100% 50%, rgba(15,36,48,0.22), rgba(15,36,48,0)) 100% 0 / 14px 100% no-repeat scroll",
                }}
              >
                <table
                  aria-label="Visit details"
                  className="w-full text-left text-sm print:text-[9px]"
                >
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      {visitColumns.has("visitRef") ? <th className="pb-2 pr-2 font-medium">Visit ref</th> : null}
                      {visitColumns.has("client") ? <th className="pb-2 pr-2 font-medium">Client</th> : null}
                      {visitColumns.has("caregiver") ? <th className="pb-2 pr-2 font-medium">Caregiver</th> : null}
                      {visitColumns.has("service") ? <th className="pb-2 pr-2 font-medium">Service</th> : null}
                      {visitColumns.has("date") ? <th className="pb-2 pr-2 font-medium">Date</th> : null}
                      {visitColumns.has("time") ? <th className="pb-2 pr-2 font-medium">Time</th> : null}
                      {visitColumns.has("worked") ? <th className="pb-2 pr-2 font-medium">Worked</th> : null}
                      {visitColumns.has("billable") ? <th className="pb-2 pr-2 font-medium">Billable</th> : null}
                      {visitColumns.has("authorized") ? <th className="pb-2 pr-2 font-medium">Authorized</th> : null}
                      {visitColumns.has("usedMtd") ? <th className="pb-2 pr-2 font-medium">Billable this month</th> : null}
                      {visitColumns.has("remaining") ? <th className="pb-2 pr-2 font-medium">Hours left</th> : null}
                      {showBalanceDetails ? <th className="pb-2 pr-2 font-medium">Hours left</th> : null}
                      {visitColumns.has("status") ? <th className="pb-2 pr-2 font-medium">Status</th> : null}
                      {canManage ? <th className="pb-2 font-medium print:hidden">Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVisitRows.map((row) => {
                      const authorizedMinutes =
                        row.month_to_date_after_minutes !== null &&
                        row.remaining_minutes !== null
                          ? row.month_to_date_after_minutes + row.remaining_minutes
                          : null;
                      return (
                        <Fragment key={row.id}>
                          <tr className="border-b border-slate-100 last:border-0">
                            {visitColumns.has("visitRef") ? (
                              <td className="py-2 pr-2 whitespace-nowrap font-mono text-xs text-slate-500">
                                {row.visit_number ?? "—"}
                              </td>
                            ) : null}
                            {visitColumns.has("client") ? (
                              <td className="min-w-[9rem] print:min-w-0 py-2 pr-2">
                                <p className="font-medium text-slate-900">
                                  {visitClientLabel(row)}
                                </p>
                                {!visitColumns.has("visitRef") && row.visit_number ? <p className="font-mono text-[11px] text-slate-500">{row.visit_number}</p> : null}
                              </td>
                            ) : null}
                            {visitColumns.has("caregiver") ? (
                              <td className="min-w-[7.5rem] print:min-w-0 py-2 pr-2 text-slate-700">{row.caregiver_name}</td>
                            ) : null}
                            {visitColumns.has("service") ? (
                              <td className="min-w-[7rem] print:min-w-0 py-2 pr-2 text-slate-700">{row.service_name}</td>
                            ) : null}
                            {visitColumns.has("date") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-600">
                                {formatDateOnly(row.service_date)}
                              </td>
                            ) : null}
                            {visitColumns.has("time") ? (
                              <td className="py-2 pr-2 whitespace-nowrap font-mono text-xs text-slate-600">
                                {formatTimeRange(row.time_in, row.time_out)}
                                <p className="font-sans text-slate-500">
                                  {row.scheduled_starts_at ? "Scheduled " : ""}
                                  {formatScheduledWindow(row.scheduled_starts_at, row.scheduled_ends_at, row.caregiver_scheduling_mode)}
                                </p>
                              </td>
                            ) : null}
                            {visitColumns.has("worked") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-700">
                                {formatDuration(row.worked_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("billable") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-700">
                                {formatDuration(row.billable_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("authorized") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-700">
                                {formatDuration(authorizedMinutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("usedMtd") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-700">
                                {formatDuration(row.month_to_date_after_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("remaining") ? (
                              <td className="py-2 pr-2 whitespace-nowrap text-slate-700">
                                {formatBalance(row.remaining_minutes)}
                              </td>
                            ) : null}
                            {showBalanceDetails ? (
                              <td className="py-2 pr-2 align-top">
                                {/* A printout cannot open a control, so print shows the same three values in full. */}
                                <dl className="hidden space-y-0.5 whitespace-nowrap text-[10px] print:block">
                                  <div><dt className="inline">Authorized: </dt><dd className="inline font-medium">{formatDuration(authorizedMinutes)}</dd></div>
                                  <div><dt className="inline">Billable this month: </dt><dd className="inline font-medium">{formatDuration(row.month_to_date_after_minutes)}</dd></div>
                                  <div><dt className="inline">Hours left: </dt><dd className="inline font-medium">{formatBalance(row.remaining_minutes)}</dd></div>
                                </dl>
                                <details className="text-xs print:hidden">
                                  <summary className="inline-flex min-h-[32px] cursor-pointer list-none items-center text-sm font-medium text-og-link underline underline-offset-2">
                                    Hours left
                                  </summary>
                                  <dl className="mt-1 space-y-1 whitespace-nowrap">
                                    <div><dt className="inline text-slate-500">Authorized: </dt><dd className="inline font-medium text-slate-900">{formatDuration(authorizedMinutes)}</dd></div>
                                    <div><dt className="inline text-slate-500">Billable this month: </dt><dd className="inline font-medium text-slate-900">{formatDuration(row.month_to_date_after_minutes)}</dd></div>
                                    <div><dt className="inline text-slate-500">Hours left: </dt><dd className="inline font-medium text-slate-900">{formatBalance(row.remaining_minutes)}</dd></div>
                                  </dl>
                                </details>
                              </td>
                            ) : null}
                            {visitColumns.has("status") ? (
                              <td className="py-2 pr-2">
                                {row.status === "corrected" ? (
                                  <StatusBadge label="Replaced by a correction" tone="neutral" />
                                ) : row.is_corrected && row.status === "signed" ? (
                                  <StatusBadge label="Confirmed · Revised" tone="success" />
                                ) : (
                                  <StatusBadge
                                    label={VISIT_STATUS_LABEL[row.status]}
                                    tone={STATUS_TONE[row.status]}
                                  />
                                )}
                                {row.time_out_entered_by_manager ? (
                                  <span className="ml-1 inline-block">
                                    <StatusBadge label="Time Out entered by manager" tone="warning" />
                                  </span>
                                ) : null}
                              </td>
                            ) : null}
                            {canManage ? (
                              <td className="py-2 print:hidden">
                                <div className="flex flex-col items-start gap-1.5">
                                  {backend.kind === "aws" && row.status === "administrator_review" ? (
                                    <Link to={`/visits/${row.id}`} className="inline-flex min-h-[40px] items-center whitespace-nowrap rounded-lg border border-amber-600 px-3 text-sm font-medium text-amber-900 hover:bg-amber-50">
                                      Review
                                    </Link>
                                  ) : null}
                                  {row.status === "signed" ||
                                  row.status === "administrator_review" ? (
                                    <button
                                      type="button"
                                      onClick={() => openCorrect(row)}
                                      className="inline-flex min-h-[32px] items-center whitespace-nowrap px-1 text-sm font-medium text-og-link underline underline-offset-2 hover:bg-slate-50"
                                    >
                                      Correct
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => openHistory(row)}
                                    className="inline-flex min-h-[40px] items-center whitespace-nowrap rounded-lg px-2 text-sm font-medium text-og-link underline underline-offset-2 hover:bg-slate-50"
                                  >
                                    History
                                  </button>
                                </div>
                              </td>
                            ) : null}
                          </tr>
                          {expandedVisitId === row.id && expandedMode === "correct" ? (
                            <tr className="border-b border-slate-100 bg-slate-50 print:hidden">
                              <td colSpan={visibleVisitColumnCount} className="p-4">
                                {renderCorrectionPanel(row)}
                              </td>
                            </tr>
                          ) : null}
                          {expandedVisitId === row.id && expandedMode === "history" ? (
                            <tr className="border-b border-slate-100 bg-slate-50 print:hidden">
                              <td colSpan={visibleVisitColumnCount} className="p-4">
                                {renderHistoryPanel()}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-200 pt-3 text-sm font-medium text-slate-800">
                  <span>Worked: {formatDuration(totalWorkedMinutes)}</span>
                  <span>Billable: {formatDuration(totalBillableMinutes)}</span>
                </div>
              </div>
            )}
          </Card>

          {clientServiceSubtotals.length > 0 ? (
            <Card>
              <h3 className="font-semibold text-slate-950">
                By client and service
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Service totals remain separate even when one client has multiple services.
              </p>
              <ul className="mt-3 divide-y divide-slate-100">
                {clientServiceSubtotals.map((entry) => (
                  <li
                    key={entry.key}
                    className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      {entry.legalName ?? entry.code} · {entry.serviceName}
                      <span className="text-slate-500"> · {entry.visits} {entry.visits === 1 ? "visit" : "visits"}</span>
                    </span>
                    <span className="font-medium text-slate-900">
                      {formatDuration(entry.workedMinutes)} worked · {formatDuration(entry.billableMinutes)} billable
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : null}

      {reportView === "exceptions" && incompleteVisits.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            Incomplete visits ({incompleteVisits.length})
          </h3>
          <details className="mt-1 text-xs text-slate-500">
          <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">What these mean</summary>
          <p>
            Missing Time Out: still open past the scheduled shift end (or open{" "}
            {UNSCHEDULED_OPEN_VISIT_ALERT_HOURS}+ hours with no scheduled shift). Not confirmed: signed out over an
            hour ago without a client confirmation or a no-signer reason. Ask
            the caregiver to finish the visit on their phone.
          </p>
          </details>
          <ul className="mt-3 divide-y divide-slate-100">
            {incompleteVisits.map(({ row, issue }) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-700">
                    {visitClientLabel(row)}{" "}
                    <span className="text-slate-500">
                      · {row.caregiver_name} · Time In {formatDateTime(row.time_in)}
                      {row.scheduled_starts_at
                        ? ` · Scheduled ${formatScheduledWindow(row.scheduled_starts_at, row.scheduled_ends_at, row.caregiver_scheduling_mode)}`
                        : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge
                      label={issue.kind === "missing_time_out" ? "Missing Time Out" : "Not confirmed"}
                      tone={issue.kind === "missing_time_out" ? "danger" : "warning"}
                    />
                    <span className="text-xs text-slate-500">
                      {issue.kind === "not_confirmed"
                        ? `Signed out ${formatOverdue(issue.minutesSinceTimeOut)} ago`
                        : issue.reason === "past_scheduled_end"
                          ? `${formatOverdue(issue.minutesOverdue)} past scheduled end`
                          : `Open ${formatOverdue(issue.minutesOverdue + UNSCHEDULED_OPEN_VISIT_ALERT_HOURS * 60)}, no scheduled shift`}
                    </span>
                    {canManage && issue.kind === "missing_time_out" && closeForm?.visitId !== row.id ? (
                      <Button type="button" variant="secondary" onClick={() => openClose(row)}>
                        Close visit
                      </Button>
                    ) : null}
                  </span>
                </div>
                {closeForm?.visitId === row.id ? (
                  <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs text-slate-600">
                      Enter when the visit actually ended. The caregiver&apos;s app then
                      asks for the client&apos;s confirmation, marked as entered by the agency.
                    </p>
                    {row.scheduled_ends_at ? (
                      <p className="text-xs text-slate-500">
                        Scheduled end: {formatVisitDate(row.scheduled_ends_at)}, {formatClockTime(row.scheduled_ends_at)}
                      </p>
                    ) : null}
                    <PacificTimeOutField
                      timeIn={closeForm.timeIn}
                      value={closeForm.timeOut}
                      onChange={(timeOut) => {
                        setCloseError(null);
                        setCloseForm({ ...closeForm, timeOut });
                      }}
                    />
                    <label className="block text-xs font-medium text-slate-700">
                      Reason
                      <textarea
                        value={closeForm.reason}
                        onChange={(event) => setCloseForm({ ...closeForm, reason: event.target.value })}
                        rows={2}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                    {closeError ? (
                      <p role="alert" className="text-sm font-medium text-red-700">
                        {closeError}
                      </p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button type="button" loading={closeSaving} onClick={() => void handleSubmitClose()}>
                        Save Time Out
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => setCloseForm(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {reportView === "exceptions" && exceptionVisits.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Exception visits</h3>
          <details className="mt-1 text-xs text-slate-500">
            <summary className="inline-flex min-h-[32px] cursor-pointer items-center text-og-accent underline">What counts as an exception</summary>
            <p>Visits that needed a human to look at them: flagged for administrator review, an authorization status other than within-authorization, or already corrected.</p>
          </details>
          <ul className="mt-3 divide-y divide-slate-100">
            {exceptionVisits.map((row) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-700">
                    {visitClientLabel(row)}{" "}
                    <span className="text-slate-500">
                      · {row.caregiver_name} ·{" "}
                      {formatDateOnly(row.service_date)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {row.status === "administrator_review" ? (
                      <StatusBadge
                        label={VISIT_STATUS_LABEL[row.status]}
                        tone="danger"
                      />
                    ) : null}
                    {backend.kind === "aws" && row.status === "administrator_review" ? (
                      <Link to={`/visits/${row.id}`} className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-600 px-3 text-sm font-medium text-amber-900 md:min-h-[32px]">
                        Review
                      </Link>
                    ) : null}
                    {row.is_corrected ? (
                      <StatusBadge label="Corrected" tone="neutral" />
                    ) : null}
                    {row.authorization_status &&
                    row.authorization_status !== "within_authorization" ? (
                      <StatusBadge
                        label={
                          AUTHORIZATION_STATUS_LABEL[row.authorization_status]
                        }
                        tone="warning"
                      />
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : reportView === "exceptions" && incompleteVisits.length === 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Exceptions</h3>
          <p className="mt-3 text-sm text-emerald-700">
            No visits currently need manager attention for these filters.
          </p>
        </Card>
      ) : null}
    </section>
  );
}
