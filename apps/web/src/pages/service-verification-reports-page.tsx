import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  type MonthlyServiceSummaryRow,
  type OrgLetterhead,
  type VisitCorrectionRow,
  type VisitReportRow,
} from "@/lib/sv-backend";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import {
  AUTHORIZATION_STATUS_LABEL,
  classifyIncompleteVisit,
  UNSCHEDULED_OPEN_VISIT_ALERT_HOURS,
  formatDateTime,
  formatDuration,
  formatNumericDate,
  formatScheduledWindow,
  formatTimeRange,
  VISIT_STATUS_LABEL,
  type ServiceVisitStatus,
} from "@/lib/service-verification";





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
  "all" | "week" | "biweekly" | "month" | "quarter" | "year" | "custom";

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
  { key: "usedMtd", label: "Used MTD" },
  { key: "remaining", label: "Remaining" },
  { key: "status", label: "Status" },
];

const DEFAULT_VISIT_COLUMNS = VISIT_COLUMN_OPTIONS.map((column) => column.key);

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

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const csv = [header, ...rows].map((row) => row.map(csvQuote).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Excludes voided and superseded ('corrected') rows from every subtotal -
// a corrected visit's replacement carries the numbers that should count,
// and a voided visit was never real time to begin with.
function billableRows(rows: VisitReportRow[]) {
  return rows.filter(
    (row) => row.status === "signed" || row.status === "administrator_review",
  );
}

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in the browser's local
// time - toISOString() always renders UTC, so this reformats from the
// Date object's own local getters instead.
function toLocalInputValue(value: string) {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function currentPacificMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
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
  if (preset === "week") {
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
  const queryClient = useQueryClient();
  const backend = useServiceVerificationBackend();
  // Reused for retries of the same correction; renewed when the form changes.
  const correctionKey = useRef(newIdempotencyKey());

  const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);
  const [expandedMode, setExpandedMode] = useState<
    "correct" | "history" | null
  >(null);
  const [correctionForm, setCorrectionForm] = useState({
    timeIn: "",
    timeOut: "",
    reason: "",
  });
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  // Manager close-out of a missed clock-out (closeMissedVisit).
  const [closeForm, setCloseForm] = useState<{ visitId: string; timeOut: string; reason: string } | null>(null);
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
  const [reportView, setReportView] = useState<ReportView>("overview");
  const [linkCopied, setLinkCopied] = useState(false);
  const [reportMonth, setReportMonth] = useState(currentPacificMonth);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [visitColumns, setVisitColumns] = useState<Set<VisitColumn>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ogevia.visit-report-columns") ?? "null");
      if (Array.isArray(saved)) {
        const allowed = new Set(VISIT_COLUMN_OPTIONS.map((column) => column.key));
        const valid = saved.filter((key): key is VisitColumn => allowed.has(key as VisitColumn));
        if (valid.length > 0) return new Set(valid);
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
      timeIn: toLocalInputValue(row.time_in),
      timeOut: row.time_out ? toLocalInputValue(row.time_out) : "",
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
    const newTimeIn = new Date(correctionForm.timeIn);
    const newTimeOut = new Date(correctionForm.timeOut);
    if (
      Number.isNaN(newTimeIn.getTime()) ||
      Number.isNaN(newTimeOut.getTime())
    ) {
      setCorrectionError("Enter valid times.");
      return;
    }
    if (newTimeOut.getTime() <= newTimeIn.getTime()) {
      setCorrectionError("Time out must be after time in.");
      return;
    }

    setCorrectionSaving(true);
    try {
      await backend.correctVisit({
        visitId,
        timeIn: newTimeIn.toISOString(),
        timeOut: newTimeOut.toISOString(),
        reason: correctionForm.reason.trim(),
        idempotencyKey: correctionKey.current,
      });
      correctionKey.current = newIdempotencyKey();
      closeExpanded();
      void queryClient.invalidateQueries({
        queryKey: ["service-visit-report"],
      });
    } catch (cause) {
      setCorrectionError(
        cause instanceof Error
          ? cause.message
          : "Could not correct this visit.",
      );
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
      map.set(row.client_id, row.client_legal_name ?? row.client_code),
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
  const selectedServiceName = useMemo(
    () => serviceOptions.find(([id]) => id === serviceFilter)?.[1] ?? null,
    [serviceFilter, serviceOptions],
  );

  const visibleVisitColumnCount = visitColumns.size + (canManage ? 1 : 0);

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
  const monthCalendar = useMemo(
    () => buildMonthCalendar(rows, reportMonth),
    [reportMonth, rows],
  );
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

  function openClose(row: VisitReportRow) {
    setCloseError(null);
    setCloseForm({
      visitId: row.id,
      timeOut: row.scheduled_ends_at ? toLocalInputValue(row.scheduled_ends_at) : "",
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
    const timeOut = new Date(closeForm.timeOut);
    if (Number.isNaN(timeOut.getTime())) {
      setCloseError("Enter the actual Time Out.");
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
      setCloseError(cause instanceof Error ? cause.message : "Could not close this visit.");
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

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-12 print:max-w-none print:space-y-4">
      <div className="print:hidden">
        <PageHeader
          eyebrow="Service Verification"
          title="Report Center"
          description="Choose one report, then use the filters to answer a specific operational question without loading every report at once."
          actions={
            <div className="flex flex-wrap gap-2">
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
              <Button
                type="button"
                variant="secondary"
                icon={<Printer className="h-4 w-4" />}
                onClick={handlePrint}
              >
                Print / Save as PDF
              </Button>
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
                setReportView(event.target.value as ReportView);
                closeExpanded();
              }}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-950"
            >
              <option value="overview">Operations overview</option>
              <option value="caregiver">Caregiver hours</option>
              <option value="calendar">Client monthly calendar</option>
              <option value="reconciliation">Monthly hours & billing reconciliation</option>
              <option value="corrections">Correction history</option>
              <option value="visits">Visit details</option>
              <option value="exceptions">Exceptions needing attention</option>
              {canManage ? <option value="staff-access">Staff access</option> : null}
            </select>
          </div>
          <p className="max-w-xl pb-2 text-sm text-slate-500">
            Select one report, then narrow it by client, caregiver, service, location, status, and date below.
          </p>
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

      {reportView !== "staff-access" ? (
        <Card className="print:hidden">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <div>
              <label
                htmlFor="report-from"
                className="block text-xs font-medium text-slate-600"
              >
                From
              </label>
              <input
                id="report-from"
                type="date"
                value={dateFrom}
                onChange={(event) => {
                  setDateFrom(event.target.value);
                  setDatePreset("custom");
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label
                htmlFor="report-to"
                className="block text-xs font-medium text-slate-600"
              >
                To
              </label>
              <input
                id="report-to"
                type="date"
                value={dateTo}
                onChange={(event) => {
                  setDateTo(event.target.value);
                  setDatePreset("custom");
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Date range">
            {(
              [
                ["all", "All time"],
                ["week", "This week"],
                ["biweekly", "Last 14 days"],
                ["month", "This month"],
                ["quarter", "This quarter"],
                ["year", "This year"],
                ["custom", "Custom"],
              ] as Array<[DatePreset, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => applyDatePreset(value)}
                className={
                  datePreset === value
                    ? "rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white"
                    : "rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                }
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Use From and To for a week, your agency pay period, a month, or any
            custom range. These reports use actual signed visit time—not a fixed
            schedule.
          </p>
        </Card>
      ) : null}

      {reportView === "overview" ? (
        <>
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
                <p className="mt-1 text-sm text-slate-500">
                  Every chart follows the client, caregiver, service, location,
                  and date filters above.
                </p>
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
            <p className="mt-4 text-sm text-slate-400">
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
        <div className="flex items-start justify-between border-b border-slate-300 pb-4">
          <div>
            {letterhead?.logo_url ? (
              <img
                src={letterhead.logo_url}
                alt={letterhead.display_name}
                className="mb-2 max-h-14"
              />
            ) : null}
            <p className="text-lg font-semibold">
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
          <div className="text-right text-sm text-slate-600">
            <p className="font-semibold">
              {reportView === "calendar"
                ? "Client Monthly Service Calendar"
                : reportView === "reconciliation"
                  ? "Monthly Hours & Billing Reconciliation"
                  : reportView === "corrections"
                    ? "Correction History"
                    : "Service Verification Report"}
            </p>
            {selectedClientName ? <p>Client: {selectedClientName}</p> : null}
            {selectedCaregiverName ? <p>Caregiver: {selectedCaregiverName}</p> : null}
            {reportView === "calendar" || reportView === "reconciliation" ? (
              <p>Month: {reportMonth}</p>
            ) : null}
            <p>Printed: {new Date().toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      {reportView === "calendar" ? (
        <Card className="print:border-none print:p-0 print:shadow-none">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 h-5 w-5 text-sky-700" />
              <div>
                <h3 className="font-semibold text-slate-950">
                  Client monthly service calendar
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  One client per calendar. Every worked date shows the service
                  and actual hours. Different services are never combined.
                </p>
              </div>
            </div>
            <div className="flex items-end gap-2 print:hidden">
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
              {clientFilter && monthlyServiceRows.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  onClick={() =>
                    downloadCsv(
                      `client-service-calendar-${reportMonth}.csv`,
                      [
                        "Client",
                        "Service",
                        "Authorization period",
                        "Authorized",
                        "Worked",
                        "Confirmed",
                        "Billable",
                        "Remaining",
                        "Needs review",
                      ],
                      monthlyServiceRows.map((row) => [
                        row.clientCode,
                        `${row.serviceCode} ${row.serviceName}`,
                        `${row.authorizationPeriodStart} to ${row.authorizationPeriodEnd}`,
                        formatDuration(row.authorizedMinutes),
                        formatDuration(row.workedMinutes),
                        formatDuration(row.verifiedMinutes),
                        formatDuration(row.billableMinutes),
                        formatDuration(row.remainingMinutes),
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
              Select one client above. A monthly client calendar is never
              generated by combining multiple clients.
            </div>
          ) : (
            <>
              <div className="mt-4 border-b border-slate-200 pb-3">
                <p className="font-semibold text-slate-950">
                  {selectedClientName ?? "Selected client"} · {reportMonth}
                </p>
              </div>
              <div className="mt-4 overflow-x-auto">
                <div
                  role="grid"
                  aria-label={`Service hours for ${selectedClientName ?? "selected client"} in ${reportMonth}`}
                  className="min-w-[760px]"
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
                          className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
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
                            className="min-h-28 border-b border-r border-slate-100 p-2 last:border-r-0"
                          >
                            {day ? (
                              <p className="text-xs font-semibold text-slate-600">
                                {day}
                              </p>
                            ) : null}
                            <div className="mt-1 space-y-1.5">
                              {entries.map((entry) => (
                                <div
                                  key={entry.key}
                                  className={
                                    entry.needsReview
                                      ? "rounded-md bg-amber-50 px-1.5 py-1"
                                      : "rounded-md bg-sky-50 px-1.5 py-1"
                                  }
                                >
                                  <p
                                    className="text-[11px] font-semibold text-slate-800"
                                    title={entry.serviceName}
                                  >
                                    {entry.serviceName}
                                  </p>
                                  <p className="text-[11px] font-medium tabular-nums text-slate-700">
                                    {formatDuration(entry.workedMinutes)}
                                  </p>
                                  {entry.billableMinutes !== entry.workedMinutes ? (
                                    <p className="text-[10px] tabular-nums text-slate-500">
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

              <div className="mt-5">
                <h4 className="font-semibold text-slate-950">
                  Monthly totals by service
                </h4>
                {monthlyServiceSummaryQuery.isLoading ? (
                  <p className="mt-2 text-sm text-slate-500">Loading totals…</p>
                ) : monthlyServiceRows.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">
                    No authorization/service totals are available for this month.
                  </p>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-sm" aria-label="Monthly service totals">
                      <thead>
                        <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                          <th className="pb-2 pr-3 font-medium">Service</th>
                          <th className="pb-2 pr-3 font-medium">Authorized</th>
                          <th className="pb-2 pr-3 font-medium">Worked</th>
                          <th className="pb-2 pr-3 font-medium">Confirmed</th>
                          <th className="pb-2 pr-3 font-medium">Billable</th>
                          <th className="pb-2 pr-3 font-medium">Remaining</th>
                          <th className="pb-2 font-medium">Needs review</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monthlyServiceRows.map((row) => (
                          <tr key={row.authorizationLineageId} className="border-b border-slate-100">
                            <td className="py-2 pr-3 font-medium text-slate-800">
                              {row.serviceCode} · {row.serviceName}
                            </td>
                            <td className="py-2 pr-3">{formatDuration(row.authorizedMinutes)}</td>
                            <td className="py-2 pr-3">{formatDuration(row.workedMinutes)}</td>
                            <td className="py-2 pr-3">{formatDuration(row.verifiedMinutes)}</td>
                            <td className="py-2 pr-3">{formatDuration(row.billableMinutes)}</td>
                            <td className="py-2 pr-3">{formatDuration(row.remainingMinutes)}</td>
                            <td className="py-2">{formatDuration(row.reviewMinutes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </Card>
      ) : null}

      {reportView === "reconciliation" ? (
        <Card className="print:border-none print:p-0 print:shadow-none">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-950">
                Monthly hours & billing reconciliation
              </h3>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Each row is one client + service + authorization lineage.
                Services are never combined. Worked and billable time remain
                separate so documentation or authorization differences cannot
                be hidden by a client-level total.
              </p>
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
              {monthlyServiceRows.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  onClick={() =>
                    downloadCsv(
                      `monthly-service-reconciliation-${reportMonth}.csv`,
                      [
                        "Client",
                        "Service",
                        "Authorization period",
                        "Authorized",
                        "Worked",
                        "Verified",
                        "Billable",
                        "Remaining",
                        "Needs review",
                        "Worked minus billable",
                      ],
                      monthlyServiceRows.map((row) => [
                        row.clientCode,
                        `${row.serviceCode} ${row.serviceName}`,
                        `${row.authorizationPeriodStart} to ${row.authorizationPeriodEnd}`,
                        formatDuration(row.authorizedMinutes),
                        formatDuration(row.workedMinutes),
                        formatDuration(row.verifiedMinutes),
                        formatDuration(row.billableMinutes),
                        formatDuration(row.remainingMinutes),
                        formatDuration(row.reviewMinutes),
                        formatDuration(Math.max(0, row.workedMinutes - row.billableMinutes)),
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
                    <th className="pb-2 pr-3 font-medium">Billable</th>
                    <th className="pb-2 pr-3 font-medium">Remaining</th>
                    <th className="pb-2 pr-3 font-medium">Needs review</th>
                    <th className="pb-2 font-medium">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyServiceRows.map((row) => {
                    const difference = Math.max(0, row.workedMinutes - row.billableMinutes);
                    return (
                      <tr key={row.authorizationLineageId} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-medium text-slate-800">{row.clientCode}</td>
                        <td className="py-2 pr-3">
                          <p className="font-medium text-slate-800">{row.serviceCode} · {row.serviceName}</p>
                          <p className="text-xs text-slate-400">
                            {row.authorizationPeriodStart}–{row.authorizationPeriodEnd}
                          </p>
                        </td>
                        <td className="py-2 pr-3">{formatDuration(row.authorizedMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.workedMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.verifiedMinutes)}</td>
                        <td className="py-2 pr-3 font-medium">{formatDuration(row.billableMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.remainingMinutes)}</td>
                        <td className="py-2 pr-3">{formatDuration(row.reviewMinutes)}</td>
                        <td className="py-2">
                          {difference > 0 ? (
                            <StatusBadge
                              label={`${formatDuration(difference)} worked not billable`}
                              tone="warning"
                            />
                          ) : (
                            <StatusBadge label="Matched" tone="success" />
                          )}
                        </td>
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
            {correctionRows.length > 0 ? (
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
                      "Client",
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
                      row.clientCode,
                      `${row.serviceCode} ${row.serviceName}`,
                      row.serviceDate,
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
                      <td className="py-2 pr-3">{row.clientCode}</td>
                      <td className="py-2 pr-3">{row.serviceCode} · {row.serviceName}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatNumericDate(`${row.serviceDate}T12:00:00Z`)}</td>
                      <td className="py-2 pr-3">{row.caregiverName}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatTimeRange(row.beforeSnapshot.timeIn, row.beforeSnapshot.timeOut)}
                        <span className="block text-xs text-slate-400">{formatDuration(row.beforeSnapshot.workedMinutes)}</span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatTimeRange(row.afterSnapshot.timeIn, row.afterSnapshot.timeOut)}
                        <span className="block text-xs text-slate-400">{formatDuration(row.afterSnapshot.workedMinutes)}</span>
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
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={showSuperseded}
                    onChange={(event) => setShowSuperseded(event.target.checked)}
                  />
                  Show superseded records
                </label>
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                    Columns
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-52 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
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
              <p className="mt-3 text-sm text-slate-400">
                No visits match these filters.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table
                  aria-label="Visit details"
                  className="w-full text-left text-sm"
                >
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      {visitColumns.has("visitRef") ? <th className="pb-2 pr-3 font-medium">Visit ref</th> : null}
                      {visitColumns.has("client") ? <th className="pb-2 pr-3 font-medium">Client</th> : null}
                      {visitColumns.has("caregiver") ? <th className="pb-2 pr-3 font-medium">Caregiver</th> : null}
                      {visitColumns.has("service") ? <th className="pb-2 pr-3 font-medium">Service</th> : null}
                      {visitColumns.has("date") ? <th className="pb-2 pr-3 font-medium">Date</th> : null}
                      {visitColumns.has("time") ? <th className="pb-2 pr-3 font-medium">Time</th> : null}
                      {visitColumns.has("worked") ? <th className="pb-2 pr-3 font-medium">Worked</th> : null}
                      {visitColumns.has("billable") ? <th className="pb-2 pr-3 font-medium">Billable</th> : null}
                      {visitColumns.has("authorized") ? <th className="pb-2 pr-3 font-medium">Authorized</th> : null}
                      {visitColumns.has("usedMtd") ? <th className="pb-2 pr-3 font-medium">Used MTD</th> : null}
                      {visitColumns.has("remaining") ? <th className="pb-2 pr-3 font-medium">Remaining</th> : null}
                      {visitColumns.has("status") ? <th className="pb-2 pr-3 font-medium">Status</th> : null}
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
                              <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs text-slate-500">
                                {row.visit_number ?? "—"}
                              </td>
                            ) : null}
                            {visitColumns.has("client") ? (
                              <td className="py-2 pr-3">
                                <p className="text-slate-800">
                                  {row.client_legal_name ?? row.client_code}
                                </p>
                                <p className="text-xs text-slate-400">{row.client_code}</p>
                              </td>
                            ) : null}
                            {visitColumns.has("caregiver") ? (
                              <td className="py-2 pr-3 text-slate-700">{row.caregiver_name}</td>
                            ) : null}
                            {visitColumns.has("service") ? (
                              <td className="py-2 pr-3 text-slate-700">{row.service_name}</td>
                            ) : null}
                            {visitColumns.has("date") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-600">
                                {formatNumericDate(`${row.service_date}T12:00:00-07:00`)}
                              </td>
                            ) : null}
                            {visitColumns.has("time") ? (
                              <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs text-slate-600">
                                {formatTimeRange(row.time_in, row.time_out)}
                                <p className="font-sans text-slate-400">
                                  {row.scheduled_starts_at ? "Scheduled " : ""}
                                  {formatScheduledWindow(row.scheduled_starts_at, row.scheduled_ends_at)}
                                </p>
                              </td>
                            ) : null}
                            {visitColumns.has("worked") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                                {formatDuration(row.worked_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("billable") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                                {formatDuration(row.billable_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("authorized") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                                {formatDuration(authorizedMinutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("usedMtd") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                                {formatDuration(row.month_to_date_after_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("remaining") ? (
                              <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                                {formatDuration(row.remaining_minutes)}
                              </td>
                            ) : null}
                            {visitColumns.has("status") ? (
                              <td className="py-2 pr-3">
                                {row.status === "corrected" ? (
                                  <StatusBadge label="Superseded" tone="neutral" />
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
                                <div className="flex gap-2">
                                  {row.status === "signed" ||
                                  row.status === "administrator_review" ? (
                                    <button
                                      type="button"
                                      onClick={() => openCorrect(row)}
                                      className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                                    >
                                      Correct
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => openHistory(row)}
                                    className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
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
                                <p className="text-sm font-semibold text-slate-900">Correct this visit</p>
                                <p className="mt-1 text-xs text-slate-500">
                                  The signed record is never overwritten. The correction creates a
                                  linked revision and preserves the original in History.
                                </p>
                                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                  <div>
                                    <label htmlFor="correction-time-in" className="block text-xs font-medium text-slate-600">
                                      Time in
                                    </label>
                                    <input
                                      id="correction-time-in"
                                      type="datetime-local"
                                      value={correctionForm.timeIn}
                                      onChange={(event) =>
                                        setCorrectionForm({ ...correctionForm, timeIn: event.target.value })
                                      }
                                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                                    />
                                  </div>
                                  <div>
                                    <label htmlFor="correction-time-out" className="block text-xs font-medium text-slate-600">
                                      Time out
                                    </label>
                                    <input
                                      id="correction-time-out"
                                      type="datetime-local"
                                      value={correctionForm.timeOut}
                                      onChange={(event) =>
                                        setCorrectionForm({ ...correctionForm, timeOut: event.target.value })
                                      }
                                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                                    />
                                  </div>
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
                                {correctionError ? <p className="mt-2 text-sm text-red-700">{correctionError}</p> : null}
                                <div className="mt-3 flex gap-3">
                                  <Button type="button" loading={correctionSaving} onClick={() => handleSubmitCorrection(row.id)}>
                                    {correctionSaving ? "Saving…" : "Save correction"}
                                  </Button>
                                  <button type="button" onClick={closeExpanded} className="text-sm font-medium text-slate-600 hover:text-slate-900">
                                    Cancel
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                          {expandedVisitId === row.id && expandedMode === "history" ? (
                            <tr className="border-b border-slate-100 bg-slate-50 print:hidden">
                              <td colSpan={visibleVisitColumnCount} className="p-4">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-semibold text-slate-900">Correction history</p>
                                  <button type="button" onClick={closeExpanded} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                                    Close
                                  </button>
                                </div>
                                {correctionsQuery.isLoading ? (
                                  <p className="mt-2 text-sm text-slate-500">Loading…</p>
                                ) : (correctionsQuery.data ?? []).length === 0 ? (
                                  <p className="mt-2 text-sm text-slate-400">No corrections recorded for this visit.</p>
                                ) : (
                                  <ul className="mt-2 space-y-2">
                                    {(correctionsQuery.data ?? []).map((entry, index) => (
                                      <li key={entry.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
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
                      <span className="text-slate-400"> · {entry.visits} visits</span>
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
          <p className="mt-1 text-xs text-slate-500">
            Missing Time Out: still open past the scheduled shift end (or open{" "}
            {UNSCHEDULED_OPEN_VISIT_ALERT_HOURS}+ hours with no scheduled shift). Not confirmed: signed out over an
            hour ago without a client confirmation or a no-signer reason. Ask
            the caregiver to finish the visit on their phone.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {incompleteVisits.map(({ row, issue }) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-700">
                    {row.client_legal_name ?? row.client_code}{" "}
                    <span className="text-slate-400">
                      · {row.caregiver_name} · Time In {formatDateTime(row.time_in)}
                      {row.scheduled_starts_at
                        ? ` · Scheduled ${formatScheduledWindow(row.scheduled_starts_at, row.scheduled_ends_at)}`
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
                    <label className="block text-xs font-medium text-slate-700">
                      Actual Time Out
                      <input
                        type="datetime-local"
                        value={closeForm.timeOut}
                        onChange={(event) => setCloseForm({ ...closeForm, timeOut: event.target.value })}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-700">
                      Reason
                      <textarea
                        value={closeForm.reason}
                        onChange={(event) => setCloseForm({ ...closeForm, reason: event.target.value })}
                        rows={2}
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                    {closeError ? <p className="text-xs text-red-700">{closeError}</p> : null}
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
          <p className="mt-1 text-xs text-slate-500">
            Visits that needed a human to look at them: flagged for
            administrator review, an authorization status other than
            within-authorization, or already corrected.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {exceptionVisits.map((row) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-700">
                    {row.client_legal_name ?? row.client_code}{" "}
                    <span className="text-slate-400">
                      · {row.caregiver_name} ·{" "}
                      {formatNumericDate(`${row.service_date}T12:00:00-07:00`)}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {row.status === "administrator_review" ? (
                      <StatusBadge
                        label={VISIT_STATUS_LABEL[row.status]}
                        tone="danger"
                      />
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
