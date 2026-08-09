import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Printer } from "lucide-react";
import { Button, Card, PageHeader, StatusBadge, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import {
  formatDateTime,
  formatHours,
  formatVisitDate,
  VISIT_STATUS_LABEL,
  type ServiceVisitStatus
} from "@/lib/service-verification";

interface VisitReportRow {
  id: string;
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
  authorization_status: string | null;
  signed_at: string | null;
  original_visit_id: string | null;
  is_corrected: boolean;
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

const STATUS_TONE: Record<ServiceVisitStatus, StatusTone> = {
  draft: "info",
  awaiting_signature: "warning",
  signed: "success",
  administrator_review: "danger",
  corrected: "neutral",
  voided: "neutral"
};

function sumMinutes(rows: VisitReportRow[], key: "worked_minutes" | "billable_minutes") {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

// Excludes voided and superseded ('corrected') rows from every subtotal -
// a corrected visit's replacement carries the numbers that should count,
// and a voided visit was never real time to begin with.
function billableRows(rows: VisitReportRow[]) {
  return rows.filter((row) => row.status === "signed" || row.status === "administrator_review");
}

export function ServiceVerificationReportsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const canRead = hasPermission("visits.read");

  const [clientFilter, setClientFilter] = useState("");
  const [caregiverFilter, setCaregiverFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const visitsQuery = useQuery({
    queryKey: [
      "service-visit-report",
      activeOrganizationId,
      clientFilter,
      caregiverFilter,
      serviceFilter,
      statusFilter,
      dateFrom,
      dateTo
    ],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_service_visits", {
        target_organization_id: activeOrganizationId!,
        filter_client_id: clientFilter || null,
        filter_caregiver_user_id: caregiverFilter || null,
        filter_service_id: serviceFilter || null,
        filter_date_from: dateFrom || null,
        filter_date_to: dateTo || null,
        filter_status: statusFilter || null
      });
      if (error) throw error;
      return (data ?? []) as VisitReportRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const letterheadQuery = useQuery({
    queryKey: ["organization-letterhead", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("legal_name, display_name, logo_url, address_street, address_city, address_state, address_zip, contact_phone, contact_email")
        .eq("id", activeOrganizationId!)
        .single();
      if (error) throw error;
      return data as OrgLetterhead;
    },
    enabled: !!activeOrganizationId && canRead
  });

  const rows = useMemo(() => visitsQuery.data ?? [], [visitsQuery.data]);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => map.set(row.client_id, row.client_legal_name ?? row.client_code));
    return Array.from(map.entries());
  }, [rows]);

  const caregiverOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => map.set(row.caregiver_user_id, row.caregiver_name));
    return Array.from(map.entries());
  }, [rows]);

  const serviceOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => map.set(row.service_id, row.service_name));
    return Array.from(map.entries());
  }, [rows]);

  const billable = useMemo(() => billableRows(rows), [rows]);
  const totalWorkedMinutes = sumMinutes(billable, "worked_minutes");
  const totalBillableMinutes = sumMinutes(billable, "billable_minutes");

  const caregiverSubtotals = useMemo(() => {
    const map = new Map<string, { name: string; workedMinutes: number; billableMinutes: number; visits: number }>();
    for (const row of billable) {
      const entry = map.get(row.caregiver_user_id) ?? {
        name: row.caregiver_name,
        workedMinutes: 0,
        billableMinutes: 0,
        visits: 0
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      entry.visits += 1;
      map.set(row.caregiver_user_id, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.workedMinutes - a.workedMinutes);
  }, [billable]);

  const clientSubtotals = useMemo(() => {
    const map = new Map<
      string,
      { code: string; legalName: string | null; workedMinutes: number; billableMinutes: number; visits: number }
    >();
    for (const row of billable) {
      const entry = map.get(row.client_id) ?? {
        code: row.client_code,
        legalName: row.client_legal_name,
        workedMinutes: 0,
        billableMinutes: 0,
        visits: 0
      };
      entry.workedMinutes += row.worked_minutes ?? 0;
      entry.billableMinutes += row.billable_minutes ?? 0;
      entry.visits += 1;
      map.set(row.client_id, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.billableMinutes - a.billableMinutes);
  }, [billable]);

  function handlePrint() {
    window.print();
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Service Verification</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">You don&apos;t have permission to view service verification reports.</p>
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
          title="Reports"
          description="Filter signed visits for payroll and billing. Corrected and voided records are excluded from every subtotal below."
          actions={
            <Button type="button" variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={handlePrint}>
              Print / Save as PDF
            </Button>
          }
        />
      </div>

      <Card className="print:hidden">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <label htmlFor="report-client" className="block text-xs font-medium text-slate-600">
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
            <label htmlFor="report-caregiver" className="block text-xs font-medium text-slate-600">
              Caregiver
            </label>
            <select
              id="report-caregiver"
              value={caregiverFilter}
              onChange={(event) => setCaregiverFilter(event.target.value)}
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
            <label htmlFor="report-service" className="block text-xs font-medium text-slate-600">
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
            <label htmlFor="report-status" className="block text-xs font-medium text-slate-600">
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
            <label htmlFor="report-from" className="block text-xs font-medium text-slate-600">
              From
            </label>
            <input
              id="report-from"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label htmlFor="report-to" className="block text-xs font-medium text-slate-600">
              To
            </label>
            <input
              id="report-to"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
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
              <img src={letterhead.logo_url} alt={letterhead.display_name} className="mb-2 max-h-14" />
            ) : null}
            <p className="text-lg font-semibold">{letterhead?.legal_name ?? activeOrganization?.displayName}</p>
            {letterhead?.address_street ? (
              <p className="text-sm">
                {letterhead.address_street}, {letterhead.address_city}, {letterhead.address_state}{" "}
                {letterhead.address_zip}
              </p>
            ) : null}
            <p className="text-sm">
              {[letterhead?.contact_phone, letterhead?.contact_email].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="text-right text-sm text-slate-600">
            <p className="font-semibold">Service Verification Report</p>
            <p>{new Date().toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      <Card className="print:border-none print:p-0 print:shadow-none">
        <div className="flex items-center gap-3 print:hidden">
          <FileText className="h-5 w-5 text-sky-700" />
          <h3 className="font-semibold text-slate-950">Visits ({rows.length})</h3>
        </div>
        {visitsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : visitsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load service verification records.</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No visits match these filters.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-medium">Date</th>
                  <th className="pb-2 pr-3 font-medium">Client</th>
                  <th className="pb-2 pr-3 font-medium">Caregiver</th>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Time</th>
                  <th className="pb-2 pr-3 font-medium">Worked</th>
                  <th className="pb-2 pr-3 font-medium">Billable</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-slate-600">{formatVisitDate(`${row.service_date}T12:00:00-07:00`)}</td>
                    <td className="py-2 pr-3">
                      <p className="text-slate-800">{row.client_legal_name ?? row.client_code}</p>
                      <p className="text-xs text-slate-400">{row.client_code}</p>
                    </td>
                    <td className="py-2 pr-3 text-slate-700">{row.caregiver_name}</td>
                    <td className="py-2 pr-3 text-slate-600">{row.service_name}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-slate-500">
                      {formatDateTime(row.time_in)}
                      {row.time_out ? ` – ${formatDateTime(row.time_out)}` : ""}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">
                      {row.worked_minutes ? formatHours(row.worked_minutes) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">
                      {row.billable_minutes !== null ? formatHours(row.billable_minutes) : "—"}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {row.is_corrected ? <StatusBadge label="Corrected" tone="neutral" /> : null}
                        <StatusBadge label={VISIT_STATUS_LABEL[row.status]} tone={STATUS_TONE[row.status]} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
                  <td className="py-2 pr-3" colSpan={5}>
                    Total (signed + under review)
                  </td>
                  <td className="py-2 pr-3">{formatHours(totalWorkedMinutes)}</td>
                  <td className="py-2 pr-3">{formatHours(totalBillableMinutes)}</td>
                  <td className="py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {caregiverSubtotals.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">By caregiver (pay-period view)</h3>
          <ul className="mt-3 divide-y divide-slate-100">
            {caregiverSubtotals.map((entry) => (
              <li key={entry.name} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">
                  {entry.name} <span className="text-slate-400">· {entry.visits} visits</span>
                </span>
                <span className="font-medium text-slate-900">{formatHours(entry.workedMinutes)} hrs worked</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {clientSubtotals.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">By client (billing view)</h3>
          <ul className="mt-3 divide-y divide-slate-100">
            {clientSubtotals.map((entry) => (
              <li key={entry.code} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">
                  {entry.legalName ?? entry.code} <span className="text-slate-400">· {entry.visits} visits</span>
                </span>
                <span className="font-medium text-slate-900">{formatHours(entry.billableMinutes)} billable hrs</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
