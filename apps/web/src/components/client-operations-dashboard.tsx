import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  MapPin,
  Sparkles,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import { Button, Card } from "@carelik/ui";
import { supabase } from "@/lib/supabase";
import {
  calculateServiceProgress,
  formatHours,
  monthStartInTimeZone,
  type ClientOperationRow,
  type ServiceHealth,
} from "@/lib/client-operations";

const HEALTH_LABELS: Record<ServiceHealth, string> = {
  "no-service": "Service setup needed",
  "no-authorization": "Authorization needed",
  "authorization-expired": "Authorization expired",
  unassigned: "Caregiver needed",
  behind: "At risk of falling short",
  "on-track": "On track",
};

const HEALTH_STYLES: Record<ServiceHealth, string> = {
  "no-service": "bg-slate-100 text-slate-700",
  "no-authorization": "bg-rose-100 text-rose-800",
  "authorization-expired": "bg-rose-100 text-rose-800",
  unassigned: "bg-amber-100 text-amber-800",
  behind: "bg-orange-100 text-orange-800",
  "on-track": "bg-emerald-100 text-emerald-800",
};

const GAP_REASONS = [
  ["caregiver_unavailable", "Caregiver unavailable"],
  ["client_unavailable", "Client unavailable"],
  ["family_requested_change", "Family requested a change"],
  ["staffing_not_filled", "Staffing was not filled"],
  ["authorization_delay", "Authorization delay"],
  ["service_started_late", "Service started late"],
  ["other", "Other"],
] as const;

const reasonLabel = (value: string | null) =>
  GAP_REASONS.find(([key]) => key === value)?.[1] ?? "Reason not recorded";

function formatWindowTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 1, hours, minutes)));
}

function formatDay(value: string) {
  return value.slice(0, 3).replace(/^./, (letter) => letter.toUpperCase());
}

interface Props {
  organizationId: string;
  canManage: boolean;
  canSchedule: boolean;
  timeZone?: string | undefined;
}

export function ClientOperationsDashboard({
  organizationId,
  canManage,
  canSchedule,
  timeZone = "America/Los_Angeles",
}: Props) {
  const queryClient = useQueryClient();
  const monthStart = monthStartInTimeZone(new Date(), timeZone);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [reason, setReason] = useState("staffing_not_filled");
  const [notes, setNotes] = useState("");

  const operationsQuery = useQuery({
    queryKey: ["client-operations", organizationId, monthStart],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_operations", {
        target_organization_id: organizationId,
        target_month_start: monthStart,
      });
      if (error) throw error;
      return (data ?? []) as ClientOperationRow[];
    },
    enabled: canSchedule,
  });

  const saveReview = useMutation({
    mutationFn: async (row: ClientOperationRow) => {
      if (!row.service_id) throw new Error("Choose a service first.");
      const { error } = await supabase.rpc("record_client_service_gap_review", {
        target_organization_id: organizationId,
        target_client_id: row.client_id,
        target_service_id: row.service_id,
        target_month_start: monthStart,
        target_reason: reason,
        target_notes: notes.trim() || null,
        target_resolved: false,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setEditingKey(null);
      setNotes("");
      void queryClient.invalidateQueries({
        queryKey: ["client-operations", organizationId, monthStart],
      });
    },
  });

  const rows = useMemo(
    () =>
      (operationsQuery.data ?? []).map((row) => ({
        ...row,
        progress: calculateServiceProgress(row, new Date(), timeZone),
      })),
    [operationsQuery.data, timeZone],
  );

  const serviceOptions = Array.from(
    new Set(rows.map((row) => row.service_name).filter(Boolean)),
  ).sort() as string[];
  const locationOptions = Array.from(
    new Set(rows.map((row) => row.location).filter(Boolean)),
  ).sort() as string[];

  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    return (
      (!query ||
        `${row.client_name} ${row.client_code} ${row.caregiver_display_code ?? ""}`
          .toLowerCase()
          .includes(query)) &&
      (!healthFilter || row.progress.health === healthFilter) &&
      (!serviceFilter || row.service_name === serviceFilter) &&
      (!locationFilter || row.location === locationFilter)
    );
  });

  const grouped = Array.from(
    filteredRows.reduce((map, row) => {
      const current = map.get(row.client_id) ?? [];
      current.push(row);
      map.set(row.client_id, current);
      return map;
    }, new Map<string, typeof filteredRows>()),
  );

  const activeClients = new Set(
    rows
      .filter((row) => row.client_status === "active")
      .map((row) => row.client_id),
  ).size;
  const servicesAtRisk = rows.filter((row) =>
    [
      "no-authorization",
      "authorization-expired",
      "unassigned",
      "behind",
    ].includes(row.progress.health),
  ).length;
  const uncoveredServices = rows.filter(
    (row) => row.progress.health === "unassigned",
  ).length;
  const deliveredHours = rows.reduce(
    (sum, row) => sum + row.progress.deliveredHours,
    0,
  );
  const summaryCards: Array<{
    label: string;
    value: string | number;
    icon: LucideIcon;
    color: string;
  }> = [
    {
      label: "Active clients",
      value: activeClients,
      icon: UserRoundCheck,
      color: "text-indigo-700",
    },
    {
      label: "Hours delivered",
      value: formatHours(deliveredHours),
      icon: Clock3,
      color: "text-sky-700",
    },
    {
      label: "Services at risk",
      value: servicesAtRisk,
      icon: AlertTriangle,
      color: "text-orange-700",
    },
    {
      label: "Need a caregiver",
      value: uncoveredServices,
      icon: Sparkles,
      color: "text-emerald-700",
    },
  ];

  if (!canSchedule) {
    return (
      <Card>
        <h3 className="font-bold text-slate-950">
          Operational view unavailable
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          Client records remain available, but service-gap and CareScore data
          require manager scheduling access.
        </p>
      </Card>
    );
  }

  if (operationsQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading client operations…</p>;
  }

  if (operationsQuery.isError) {
    return (
      <Card className="border-rose-200 bg-rose-50">
        <h3 className="font-bold text-rose-950">
          Client operations could not load
        </h3>
        <p className="mt-2 text-sm text-rose-800">
          Client records are still available. A manager should verify that the
          Client Operations migration has been applied to this environment.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {label}
                </p>
                <p className="mt-1 text-2xl font-black text-slate-950">
                  {value}
                </p>
              </div>
              <Icon className={`h-7 w-7 ${color}`} />
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search client or Care ID"
            aria-label="Search client operations"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <select
            aria-label="Filter by operational status"
            value={healthFilter}
            onChange={(event) => setHealthFilter(event.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">All operational statuses</option>
            {Object.entries(HEALTH_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by service"
            value={serviceFilter}
            onChange={(event) => setServiceFilter(event.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">All services</option>
            {serviceOptions.map((service) => (
              <option key={service}>{service}</option>
            ))}
          </select>
          <select
            aria-label="Filter by location"
            value={locationFilter}
            onChange={(event) => setLocationFilter(event.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">All locations</option>
            {locationOptions.map((location) => (
              <option key={location}>{location}</option>
            ))}
          </select>
        </div>
      </Card>

      {grouped.map(([clientId, clientRows]) => {
        const client = clientRows[0]!;
        return (
          <Card key={clientId} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-indigo-50 via-white to-emerald-50 p-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/clients/${clientId}`}
                    className="text-lg font-black text-slate-950 hover:underline"
                  >
                    {client.client_name}
                  </Link>
                  <span className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-bold text-white">
                    Care ID{" "}
                    {client.caregiver_display_code ?? client.client_code}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-600">
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-4 w-4" />
                    {client.location ?? "Location not recorded"}
                  </span>
                  <span>{clientRows.length} service record(s)</span>
                </div>
              </div>
              <Link
                to={`/clients/${clientId}?tab=matches`}
                className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50"
              >
                Review CareScore matches
              </Link>
            </div>

            <div className="divide-y divide-slate-100">
              {clientRows.map((row) => {
                const key = `${row.client_id}:${row.service_id ?? "none"}`;
                const progress = row.progress;
                return (
                  <div key={key} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-bold text-slate-950">
                          {row.service_name ?? "No service selected"}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          Assigned:{" "}
                          {row.assigned_caregivers.join(", ") || "No caregiver"}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-bold ${HEALTH_STYLES[progress.health]}`}
                      >
                        {HEALTH_LABELS[progress.health]}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-xl bg-indigo-50 p-3">
                        <p className="text-xs font-semibold text-indigo-700">
                          Authorized
                        </p>
                        <p className="mt-1 text-xl font-black text-indigo-950">
                          {formatHours(row.max_monthly_hours)} hrs
                        </p>
                      </div>
                      <div className="rounded-xl bg-sky-50 p-3">
                        <p className="text-xs font-semibold text-sky-700">
                          Delivered
                        </p>
                        <p className="mt-1 text-xl font-black text-sky-950">
                          {formatHours(progress.deliveredHours)} hrs
                        </p>
                      </div>
                      <div className="rounded-xl bg-amber-50 p-3">
                        <p className="text-xs font-semibold text-amber-700">
                          Remaining
                        </p>
                        <p className="mt-1 text-xl font-black text-amber-950">
                          {formatHours(progress.remainingHours)} hrs
                        </p>
                      </div>
                      <div className="rounded-xl bg-emerald-50 p-3">
                        <p className="text-xs font-semibold text-emerald-700">
                          Forecast
                        </p>
                        <p className="mt-1 text-xl font-black text-emerald-950">
                          {formatHours(progress.projectedHours)} hrs
                        </p>
                      </div>
                    </div>

                    {progress.utilizationPercent !== null ? (
                      <div className="mt-3">
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-emerald-500"
                            style={{ width: `${progress.utilizationPercent}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {Math.round(progress.utilizationPercent)}% of monthly
                          authorized hours delivered
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-4 grid gap-3 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-200 p-3">
                        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                          <CalendarDays className="h-4 w-4" /> Requested care
                        </p>
                        {row.requested_windows.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {row.requested_windows.map((window, index) => (
                              <span
                                key={`${window.day}-${window.start}-${index}`}
                                className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800"
                              >
                                {formatDay(window.day)}{" "}
                                {formatWindowTime(window.start)}–
                                {formatWindowTime(window.end)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-sm text-slate-500">
                            Days and times not recorded
                          </p>
                        )}
                      </div>
                      <div className="rounded-xl border border-slate-200 p-3">
                        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                          <Sparkles className="h-4 w-4" /> Best CareScore match
                        </p>
                        <p className="mt-2 text-sm font-bold text-slate-900">
                          {row.top_match_name
                            ? `${row.top_match_name} · ${row.top_match_score}`
                            : "No eligible match yet"}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 p-3">
                        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                          {row.gap_resolved ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 text-orange-600" />
                          )}
                          Shortfall reason
                        </p>
                        <p className="mt-2 text-sm font-bold text-slate-900">
                          {reasonLabel(row.gap_reason)}
                        </p>
                        {row.gap_notes ? (
                          <p className="mt-1 text-xs text-slate-600">
                            {row.gap_notes}
                          </p>
                        ) : null}
                        {canManage && row.service_id ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKey(key);
                              setReason(
                                row.gap_reason ?? "staffing_not_filled",
                              );
                              setNotes(row.gap_notes ?? "");
                            }}
                            className="mt-2 text-xs font-bold text-indigo-700 underline"
                          >
                            {row.gap_reason ? "Update reason" : "Record reason"}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {editingKey === key ? (
                      <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="text-sm font-semibold text-slate-800">
                            Reason
                            <select
                              value={reason}
                              onChange={(event) =>
                                setReason(event.target.value)
                              }
                              className="mt-1 block w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm"
                            >
                              {GAP_REASONS.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-sm font-semibold text-slate-800">
                            Manager notes
                            <input
                              value={notes}
                              onChange={(event) => setNotes(event.target.value)}
                              placeholder="What happened and what is the recovery plan?"
                              className="mt-1 block w-full rounded-lg border border-indigo-200 px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            loading={saveReview.isPending}
                            onClick={() => saveReview.mutate(row)}
                          >
                            Save reason
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditingKey(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                        {saveReview.isError ? (
                          <p className="mt-2 text-sm text-red-700">
                            Could not save the shortfall reason.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      {grouped.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">
            No clients match the selected operational filters.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
