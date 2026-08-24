import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  CalendarDays,
  Check,
  Copy,
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
import { supabase } from "@/lib/supabase";
import {
  AUTHORIZATION_STATUS_LABEL,
  formatDateTime,
  formatHours,
  formatVisitDate,
  VISIT_STATUS_LABEL,
  type ServiceVisitStatus,
  type VisitAuthorizationStatus,
} from "@/lib/service-verification";

interface VisitReportRow {
  id: string;
  visit_number: string | null;
  client_id: string;
  client_code: string;
  client_legal_name: string | null;
  caregiver_user_id: string;
  caregiver_name: string;
  service_id: string;
  service_name: string;
  service_date: string;
  time_in: string;
  time_out: string | null;
  worked_minutes: number | null;
  verified_minutes: number | null;
  billable_minutes: number | null;
  status: ServiceVisitStatus;
  authorization_status: VisitAuthorizationStatus | null;
  signed_at: string | null;
  original_visit_id: string | null;
  is_corrected: boolean;
  month_to_date_before_minutes: number | null;
  month_to_date_after_minutes: number | null;
  remaining_minutes: number | null;
}

interface VisitCorrectionRow {
  id: string;
  corrected_by_name: string;
  reason: string;
  before_snapshot: {
    timeIn: string;
    timeOut: string;
    workedMinutes: number;
    billableMinutes: number;
  };
  after_snapshot: {
    timeIn: string;
    timeOut: string;
    workedMinutes: number;
    billableMinutes: number;
  };
  created_at: string;
}

interface OrgLetterhead {
  legal_name: string;
  display_name: string;
  logo_url: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  contact_phone: string | null;
  contact_email: string | null;
}

interface ClientLocation {
  id: string;
  address_city: string | null;
  address_state: string | null;
}

type ChartType = "bar" | "pie" | "line";
type ChartGroup = "caregiver" | "client" | "service" | "location";
type DatePreset =
  "all" | "week" | "biweekly" | "month" | "quarter" | "year" | "custom";

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

function sumMinutes(
  rows: VisitReportRow[],
  key: "worked_minutes" | "billable_minutes",
) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
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
  caregiverName: string;
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
    const caregiverKey = row.caregiver_user_id || row.caregiver_name;
    const dayEntries =
      entriesByDate.get(row.service_date) ?? new Map<string, CalendarEntry>();
    const entry = dayEntries.get(caregiverKey) ?? {
      key: caregiverKey,
      caregiverName: row.caregiver_name,
      workedMinutes: 0,
      billableMinutes: 0,
      needsReview: false,
    };
    entry.workedMinutes += row.worked_minutes ?? 0;
    entry.billableMinutes += row.billable_minutes ?? 0;
    entry.needsReview ||= row.status === "administrator_review";
    dayEntries.set(caregiverKey, entry);
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
          a.caregiverName.localeCompare(b.caregiverName),
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

  const [clientFilter, setClientFilter] = useState("");
  const [caregiverFilter, setCaregiverFilter] = useState(
    () => new URLSearchParams(window.location.search).get("caregiver") ?? "",
  );
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [chartGroup, setChartGroup] = useState<ChartGroup>("caregiver");
  const [linkCopied, setLinkCopied] = useState(false);
  const [reportMonth, setReportMonth] = useState(currentPacificMonth);

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
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_service_visits", {
        target_organization_id: activeOrganizationId!,
        filter_client_id: clientFilter || null,
        filter_caregiver_user_id: caregiverFilter || null,
        filter_service_id: serviceFilter || null,
        filter_date_from: dateFrom || null,
        filter_date_to: dateTo || null,
        filter_status: statusFilter || null,
      });
      if (error) throw error;
      return (data ?? []) as VisitReportRow[];
    },
    enabled: !!activeOrganizationId && canRead,
  });

  const letterheadQuery = useQuery({
    queryKey: ["organization-letterhead", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select(
          "legal_name, display_name, logo_url, address_street, address_city, address_state, address_zip, contact_phone, contact_email",
        )
        .eq("id", activeOrganizationId!)
        .single();
      if (error) throw error;
      return data as OrgLetterhead;
    },
    enabled: !!activeOrganizationId && canRead,
  });

  const clientLocationsQuery = useQuery({
    queryKey: ["service-report-client-locations", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, address_city, address_state")
        .eq("organization_id", activeOrganizationId!)
        .is("deleted_at", null);
      if (error) throw error;
      return (data ?? []) as ClientLocation[];
    },
    enabled: !!activeOrganizationId && canManage,
  });

  const correctionsQuery = useQuery({
    queryKey: ["visit-corrections", expandedVisitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_visit_corrections", {
        target_visit_id: expandedVisitId!,
      });
      if (error) throw error;
      return (data ?? []) as VisitCorrectionRow[];
    },
    enabled: expandedMode === "history" && !!expandedVisitId,
  });

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
      const { error } = await supabase.rpc("correct_service_visit", {
        target_visit_id: visitId,
        new_time_in: newTimeIn.toISOString(),
        new_time_out: newTimeOut.toISOString(),
        reason: correctionForm.reason.trim(),
      });
      if (error) throw error;
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

  const chartData = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; workedHours: number; billableHours: number }
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
        workedHours: 0,
        billableHours: 0,
      };
      entry.workedHours += (row.worked_minutes ?? 0) / 60;
      entry.billableHours += (row.billable_minutes ?? 0) / 60;
      grouped.set(name, entry);
    }
    return Array.from(grouped.values()).sort(
      (a, b) => b.workedHours - a.workedHours,
    );
  }, [billable, chartGroup, clientLocationMap]);

  const trendData = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; workedHours: number; billableHours: number }
    >();
    for (const row of billable) {
      const entry = grouped.get(row.service_date) ?? {
        name: row.service_date,
        workedHours: 0,
        billableHours: 0,
      };
      entry.workedHours += (row.worked_minutes ?? 0) / 60;
      entry.billableHours += (row.billable_minutes ?? 0) / 60;
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
          title="Manager dashboard"
          description="Filter recorded visits by client, caregiver, service, week, pay period, month, or any custom date range. Corrected and voided records are excluded from every subtotal below."
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

      {canManage ? (
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

      <Card className="print:hidden">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-950">Caregiver folders</h3>
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
        {[
          {
            label: "Worked hours",
            value: formatHours(totalWorkedMinutes),
            icon: <BarChart3 className="h-5 w-5" />,
            color: "bg-indigo-50 text-indigo-800 border-indigo-100",
          },
          {
            label: "Billable hours",
            value: formatHours(totalBillableMinutes),
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

      <Card className="print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-slate-950">Hours chart</h3>
            <p className="mt-1 text-sm text-slate-500">
              Every chart follows the client, caregiver, service, location, and
              date filters above.
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
                    dataKey="workedHours"
                    nameKey="name"
                    outerRadius={105}
                    label={({ name, value }) =>
                      `${name}: ${Number(value).toFixed(1)}h`
                    }
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={entry.name}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              ) : chartType === "line" ? (
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis unit="h" />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="workedHours"
                    name="Worked hours"
                    stroke="#4f46e5"
                    strokeWidth={3}
                  />
                  <Line
                    type="monotone"
                    dataKey="billableHours"
                    name="Billable hours"
                    stroke="#059669"
                    strokeWidth={3}
                  />
                </LineChart>
              ) : (
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis unit="h" />
                  <Tooltip />
                  <Legend />
                  <Bar
                    dataKey="workedHours"
                    name="Worked hours"
                    fill="#4f46e5"
                    radius={[6, 6, 0, 0]}
                  />
                  <Bar
                    dataKey="billableHours"
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

      <Card>
        <h3 className="font-bold text-slate-950">
          Caregiver hours — {selectedClientName ?? "all clients"}
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          {selectedServiceName ?? "All services combined"} · selected date range
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
                      {formatHours(entry.workedMinutes)} hrs
                    </td>
                    <td className="py-2 text-emerald-700">
                      {formatHours(entry.billableMinutes)} hrs
                    </td>
                    <td className="py-2 text-slate-600">{entry.visits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="print:hidden">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-start gap-3">
            <CalendarDays className="mt-0.5 h-5 w-5 text-sky-700" />
            <div>
              <h3 className="font-semibold text-slate-950">
                Monthly hours calendar
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Select one client above to see every caregiver who served that
                client and the hours recorded each day. Amber entries need
                manager review.
              </p>
            </div>
          </div>
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
        </div>

        <div className="mt-4 overflow-x-auto">
          <div
            role="grid"
            aria-label={`Caregiver hours for ${reportMonth}`}
            className="min-w-[760px]"
          >
            <div
              role="row"
              className="grid grid-cols-7 border-b border-slate-200 bg-slate-50"
            >
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <div
                  key={day}
                  role="columnheader"
                  className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  {day}
                </div>
              ))}
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
                              className="truncate text-[11px] font-semibold text-slate-800"
                              title={entry.caregiverName}
                            >
                              {entry.caregiverName}
                            </p>
                            <p className="text-[11px] tabular-nums text-slate-600">
                              {formatHours(entry.workedMinutes)}h worked
                              {entry.billableMinutes !== entry.workedMinutes
                                ? ` · ${formatHours(entry.billableMinutes)}h billable`
                                : ""}
                            </p>
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
      </Card>

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
            <p className="font-semibold">Service Verification Report</p>
            {selectedCaregiverName ? (
              <p>Caregiver: {selectedCaregiverName}</p>
            ) : null}
            <p>{new Date().toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      <Card className="print:border-none print:p-0 print:shadow-none">
        <div className="flex items-center gap-3 print:hidden">
          <FileText className="h-5 w-5 text-sky-700" />
          <h3 className="font-semibold text-slate-950">
            {selectedCaregiverName
              ? `Caregiver ${selectedCaregiverName}`
              : "Visits"}{" "}
            ({rows.length})
          </h3>
        </div>
        {visitsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : visitsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">
            Could not load service verification records.
          </p>
        ) : rows.length === 0 ? (
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
                  <th className="pb-2 pr-3 font-medium">Visit #</th>
                  <th className="pb-2 pr-3 font-medium">Date</th>
                  <th className="pb-2 pr-3 font-medium">Client</th>
                  <th className="pb-2 pr-3 font-medium">Caregiver</th>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Time</th>
                  <th className="pb-2 pr-3 font-medium">Worked</th>
                  <th className="pb-2 pr-3 font-medium">Billable</th>
                  <th className="pb-2 pr-3 font-medium">
                    Authorization (before → after)
                  </th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  {canManage ? (
                    <th className="pb-2 font-medium print:hidden">Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs text-slate-500">
                        {row.visit_number ?? "—"}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-slate-600">
                        {formatVisitDate(`${row.service_date}T12:00:00-07:00`)}
                      </td>
                      <td className="py-2 pr-3">
                        <p className="text-slate-800">
                          {row.client_legal_name ?? row.client_code}
                        </p>
                        <p className="text-xs text-slate-400">
                          {row.client_code}
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {row.caregiver_name}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        {row.service_name}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-slate-500">
                        {formatDateTime(row.time_in)}
                        {row.time_out
                          ? ` – ${formatDateTime(row.time_out)}`
                          : ""}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {row.worked_minutes
                          ? formatHours(row.worked_minutes)
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {row.billable_minutes !== null
                          ? formatHours(row.billable_minutes)
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs text-slate-500">
                        {row.month_to_date_before_minutes !== null &&
                        row.month_to_date_after_minutes !== null
                          ? `${formatHours(row.month_to_date_before_minutes)} → ${formatHours(row.month_to_date_after_minutes)} (${formatHours(row.remaining_minutes ?? 0)} left)`
                          : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {row.is_corrected ? (
                            <StatusBadge label="Corrected" tone="neutral" />
                          ) : null}
                          <StatusBadge
                            label={VISIT_STATUS_LABEL[row.status]}
                            tone={STATUS_TONE[row.status]}
                          />
                        </div>
                      </td>
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
                    {expandedVisitId === row.id &&
                    expandedMode === "correct" ? (
                      <tr className="border-b border-slate-100 bg-slate-50 print:hidden">
                        <td colSpan={canManage ? 10 : 9} className="p-4">
                          <p className="text-sm font-semibold text-slate-900">
                            Correct this visit
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            The signed record is never overwritten - this
                            creates a new, linked corrected visit and marks the
                            original as superseded.
                          </p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <div>
                              <label
                                htmlFor="correction-time-in"
                                className="block text-xs font-medium text-slate-600"
                              >
                                Time in
                              </label>
                              <input
                                id="correction-time-in"
                                type="datetime-local"
                                value={correctionForm.timeIn}
                                onChange={(event) =>
                                  setCorrectionForm({
                                    ...correctionForm,
                                    timeIn: event.target.value,
                                  })
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                            <div>
                              <label
                                htmlFor="correction-time-out"
                                className="block text-xs font-medium text-slate-600"
                              >
                                Time out
                              </label>
                              <input
                                id="correction-time-out"
                                type="datetime-local"
                                value={correctionForm.timeOut}
                                onChange={(event) =>
                                  setCorrectionForm({
                                    ...correctionForm,
                                    timeOut: event.target.value,
                                  })
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                            <div>
                              <label
                                htmlFor="correction-reason"
                                className="block text-xs font-medium text-slate-600"
                              >
                                Reason (required)
                              </label>
                              <input
                                id="correction-reason"
                                required
                                value={correctionForm.reason}
                                onChange={(event) =>
                                  setCorrectionForm({
                                    ...correctionForm,
                                    reason: event.target.value,
                                  })
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                          </div>
                          {correctionError ? (
                            <p className="mt-2 text-sm text-red-700">
                              {correctionError}
                            </p>
                          ) : null}
                          <div className="mt-3 flex gap-3">
                            <Button
                              type="button"
                              loading={correctionSaving}
                              onClick={() => handleSubmitCorrection(row.id)}
                            >
                              {correctionSaving ? "Saving…" : "Save correction"}
                            </Button>
                            <button
                              type="button"
                              onClick={closeExpanded}
                              className="text-sm font-medium text-slate-600 hover:text-slate-900"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {expandedVisitId === row.id &&
                    expandedMode === "history" ? (
                      <tr className="border-b border-slate-100 bg-slate-50 print:hidden">
                        <td colSpan={canManage ? 10 : 9} className="p-4">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-slate-900">
                              Correction history
                            </p>
                            <button
                              type="button"
                              onClick={closeExpanded}
                              className="text-xs font-medium text-slate-600 hover:text-slate-900"
                            >
                              Close
                            </button>
                          </div>
                          {correctionsQuery.isLoading ? (
                            <p className="mt-2 text-sm text-slate-500">
                              Loading…
                            </p>
                          ) : (correctionsQuery.data ?? []).length === 0 ? (
                            <p className="mt-2 text-sm text-slate-400">
                              No corrections recorded for this visit.
                            </p>
                          ) : (
                            <ul className="mt-2 space-y-2">
                              {(correctionsQuery.data ?? []).map((entry) => (
                                <li
                                  key={entry.id}
                                  className="rounded-lg border border-slate-200 bg-white p-3 text-sm"
                                >
                                  <p className="text-slate-800">
                                    <span className="font-medium">
                                      {entry.corrected_by_name}
                                    </span>{" "}
                                    · {formatDateTime(entry.created_at)}
                                  </p>
                                  <p className="mt-1 text-slate-600">
                                    Reason: {entry.reason}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {formatDateTime(
                                      entry.before_snapshot.timeIn,
                                    )}{" "}
                                    –{" "}
                                    {formatDateTime(
                                      entry.before_snapshot.timeOut,
                                    )}{" "}
                                    (
                                    {formatHours(
                                      entry.before_snapshot.billableMinutes,
                                    )}
                                    h) →{" "}
                                    {formatDateTime(
                                      entry.after_snapshot.timeIn,
                                    )}{" "}
                                    –{" "}
                                    {formatDateTime(
                                      entry.after_snapshot.timeOut,
                                    )}{" "}
                                    (
                                    {formatHours(
                                      entry.after_snapshot.billableMinutes,
                                    )}
                                    h)
                                  </p>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
                  <td className="py-2 pr-3" colSpan={6}>
                    Total (signed + under review)
                  </td>
                  <td className="py-2 pr-3">
                    {formatHours(totalWorkedMinutes)}
                  </td>
                  <td className="py-2 pr-3">
                    {formatHours(totalBillableMinutes)}
                  </td>
                  <td className="py-2 pr-3" />
                  <td className="py-2" />
                  {canManage ? <td className="py-2 print:hidden" /> : null}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {clientSubtotals.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            By client (billing view)
          </h3>
          <ul className="mt-3 divide-y divide-slate-100">
            {clientSubtotals.map((entry) => (
              <li
                key={entry.code}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="text-slate-700">
                  {entry.legalName ?? entry.code}{" "}
                  <span className="text-slate-400">
                    · {entry.visits} visits
                  </span>
                </span>
                <span className="font-medium text-slate-900">
                  {formatHours(entry.billableMinutes)} billable hrs
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {exceptionVisits.length > 0 ? (
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
                      {formatVisitDate(row.service_date)}
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
      ) : null}
    </section>
  );
}
