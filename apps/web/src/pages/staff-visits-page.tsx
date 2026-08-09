import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, Clock } from "lucide-react";
import { Button, Card, cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Mobile-first self-service scheduling for caregivers. Deliberately
// scoped to what list_my_schedulable_assignments() returns - a caregiver
// can only ever see and pick from clients/services an administrator
// explicitly assigned them (see caregiver_assignments in
// 20260809150000_service_routing.sql). The cap, overlap, and assignment
// checks all happen again server-side in schedule_caregiver_visit() -
// nothing here is trusted as the real gate, only as a fast first pass so
// a caregiver isn't told "no" only after filling out the whole form.

interface AssignmentOption {
  assignment_id: string;
  client_id: string;
  client_code: string;
  client_name: string;
  service_id: string;
  service_code: string;
  service_name: string;
  service_color: string | null;
  authorization_id: string | null;
  authorization_period_start: string | null;
  authorization_period_end: string | null;
  max_monthly_hours: number | null;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
}

type Step = 1 | 2 | 3 | 4;

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function availableHours(option: AssignmentOption): number | null {
  if (option.max_monthly_hours === null) return null;
  return Math.max(0, option.max_monthly_hours - option.hours_used_this_month - option.hours_scheduled_this_month);
}

function defaultStart() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

function toLocalInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildIcsDataUrl(title: string, start: Date, end: Date, description: string) {
  const format = (date: Date) => date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `DTSTART:${format(start)}`,
    `DTEND:${format(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

const stepLabels: Record<Step, string> = {
  1: "Client",
  2: "Service",
  3: "Date & time",
  4: "Review"
};

export function StaffVisitsPage() {
  const { activeOrganizationId } = useOrganization();
  const [step, setStep] = useState<Step>(1);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<AssignmentOption | null>(null);
  const [startsAt, setStartsAt] = useState(() => toLocalInputValue(defaultStart()));
  const [endsAt, setEndsAt] = useState(() => {
    const end = defaultStart();
    end.setHours(end.getHours() + 1);
    return toLocalInputValue(end);
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ visitNumber: string } | null>(null);

  const optionsQuery = useQuery({
    queryKey: ["my-schedulable-assignments", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_my_schedulable_assignments", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AssignmentOption[];
    },
    enabled: !!activeOrganizationId
  });

  const clients = useMemo(() => {
    const byClient = new Map<string, { client_id: string; client_code: string; client_name: string }>();
    for (const row of optionsQuery.data ?? []) {
      if (!byClient.has(row.client_id)) {
        byClient.set(row.client_id, { client_id: row.client_id, client_code: row.client_code, client_name: row.client_name });
      }
    }
    return Array.from(byClient.values());
  }, [optionsQuery.data]);

  const servicesForClient = (optionsQuery.data ?? []).filter((row) => row.client_id === selectedClientId);

  function resetFlow() {
    setStep(1);
    setSelectedClientId(null);
    setSelectedAssignment(null);
    setSubmitError(null);
    setResult(null);
    setStartsAt(toLocalInputValue(defaultStart()));
    const end = defaultStart();
    end.setHours(end.getHours() + 1);
    setEndsAt(toLocalInputValue(end));
  }

  async function handleConfirm() {
    if (!activeOrganizationId || !selectedAssignment) return;
    setSubmitError(null);

    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setSubmitError("Enter a valid date and time.");
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setSubmitError("End time must be after start time.");
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("schedule_caregiver_visit", {
        target_organization_id: activeOrganizationId,
        target_client_id: selectedAssignment.client_id,
        target_service_id: selectedAssignment.service_id,
        visit_starts_at: start.toISOString(),
        visit_ends_at: end.toISOString()
      });
      if (error) throw error;
      const row = (data ?? [])[0] as { shift_id: string; visit_number: string } | undefined;
      setResult({ visitNumber: row?.visit_number ?? "Scheduled" });
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Could not schedule this visit. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    return (
      <section className="mx-auto max-w-md px-4 py-8">
        <Card className="border-2 border-[var(--routing-success)] text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--routing-success)]/10">
            <Check className="h-7 w-7 text-[var(--routing-success)]" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-[var(--routing-navy)]">Visit scheduled</h1>
          <p className="mt-1 text-sm text-slate-600">
            {selectedAssignment?.client_code} · {selectedAssignment?.service_name}
          </p>
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm text-slate-700">{result.visitNumber}</p>
          <div className="mt-6 flex flex-col gap-2.5">
            <a
              href={buildIcsDataUrl(
                `Visit: ${selectedAssignment?.service_name ?? "Care visit"}`,
                start,
                end,
                `Visit ${result.visitNumber}`
              )}
              download="visit.ics"
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Add to calendar
            </a>
            <Link
              to="/service-verification"
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View visit
            </Link>
            <Button className="min-h-[44px] bg-[var(--routing-teal)] hover:opacity-90" onClick={resetFlow}>
              Schedule another visit
            </Button>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md space-y-4 px-4 py-6 pb-28">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--routing-teal)]">Staff portal</p>
        <h1 className="mt-1 text-xl font-semibold text-[var(--routing-navy)]">Schedule a visit</h1>
      </div>

      <ol className="flex items-center gap-2" aria-label="Scheduling steps">
        {([1, 2, 3, 4] as Step[]).map((value) => (
          <li key={value} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                step === value
                  ? "bg-[var(--routing-teal)] text-white"
                  : step > value
                    ? "bg-[var(--routing-teal)]/20 text-[var(--routing-teal)]"
                    : "bg-slate-100 text-slate-400"
              )}
              aria-current={step === value ? "step" : undefined}
            >
              {step > value ? <Check className="h-4 w-4" /> : value}
            </span>
            {value < 4 ? <span className="h-0.5 flex-1 bg-slate-100" /> : null}
          </li>
        ))}
      </ol>
      <p className="text-sm font-medium text-slate-600">Step {step} of 4 · {stepLabels[step]}</p>

      {optionsQuery.isLoading ? (
        <Card>
          <p className="text-sm text-slate-500">Loading your assignments…</p>
        </Card>
      ) : optionsQuery.isError ? (
        <Card>
          <p className="text-sm text-red-700">Could not load your assigned clients. Try again.</p>
        </Card>
      ) : clients.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">
            You don&apos;t have any assigned clients yet. Contact your agency administrator to get assigned to a
            client and service before scheduling a visit.
          </p>
        </Card>
      ) : step === 1 ? (
        <div className="space-y-2.5">
          {clients.map((client) => (
            <button
              key={client.client_id}
              type="button"
              onClick={() => {
                setSelectedClientId(client.client_id);
                setSelectedAssignment(null);
                setStep(2);
              }}
              className="flex w-full min-h-[44px] items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-left shadow-sm hover:border-[var(--routing-teal)]"
            >
              <span>
                <span className="block text-sm font-semibold text-[var(--routing-navy)]">{client.client_name}</span>
                <span className="block text-xs text-slate-500">{client.client_code}</span>
              </span>
              <ChevronLeft className="h-4 w-4 rotate-180 text-slate-400" />
            </button>
          ))}
        </div>
      ) : step === 2 ? (
        <div className="space-y-2.5">
          {servicesForClient.map((option) => {
            const available = availableHours(option);
            const noAuthorization = option.authorization_id === null;
            return (
              <button
                key={option.service_id}
                type="button"
                disabled={noAuthorization}
                onClick={() => {
                  setSelectedAssignment(option);
                  setStep(3);
                }}
                className={cn(
                  "flex w-full min-h-[44px] flex-col gap-1.5 rounded-xl border bg-white px-4 py-3.5 text-left shadow-sm",
                  noAuthorization
                    ? "cursor-not-allowed border-slate-100 opacity-60"
                    : "border-slate-200 hover:border-[var(--routing-teal)]"
                )}
              >
                <span className="flex items-center gap-2">
                  {option.service_color ? (
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: option.service_color }}
                    />
                  ) : null}
                  <span className="text-sm font-semibold text-[var(--routing-navy)]">
                    {option.service_code} · {option.service_name}
                  </span>
                </span>
                {noAuthorization ? (
                  <span className="text-xs font-medium text-[var(--routing-danger)]">
                    No active authorization - contact your agency administrator.
                  </span>
                ) : (
                  <span className="text-xs text-slate-500">
                    {option.authorization_period_start} – {option.authorization_period_end} ·{" "}
                    {formatHours(option.hours_used_this_month)}h used + {formatHours(option.hours_scheduled_this_month)}h
                    scheduled of {formatHours(option.max_monthly_hours ?? 0)}h/mo
                    {available !== null ? ` (${formatHours(available)}h available)` : ""}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <ChevronLeft className="h-4 w-4" /> Back to clients
          </button>
        </div>
      ) : step === 3 && selectedAssignment ? (
        <Card>
          <div className="space-y-4">
            <div>
              <label htmlFor="visit-starts" className="block text-xs font-medium text-slate-600">
                Starts
              </label>
              <input
                id="visit-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
                className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-base text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="visit-ends" className="block text-xs font-medium text-slate-600">
                Ends
              </label>
              <input
                id="visit-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
                className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-base text-slate-900"
              />
            </div>
            {submitError ? <p className="text-sm text-[var(--routing-danger)]">{submitError}</p> : null}
          </div>
        </Card>
      ) : step === 4 && selectedAssignment ? (
        <Card>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--routing-navy)]">
            <Clock className="h-4 w-4" /> Review visit
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Client</dt>
              <dd className="font-medium text-slate-900">{selectedAssignment.client_code}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Service</dt>
              <dd className="font-medium text-slate-900">
                {selectedAssignment.service_code} · {selectedAssignment.service_name}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Starts</dt>
              <dd className="font-medium text-slate-900">{new Date(startsAt).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Ends</dt>
              <dd className="font-medium text-slate-900">{new Date(endsAt).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-3">
              <dt className="text-slate-500">Estimated duration</dt>
              <dd className="font-medium text-slate-900">
                {formatHours(
                  Math.max(0, (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3_600_000)
                )}
                h
              </dd>
            </div>
          </dl>
          {submitError ? <p className="mt-4 text-sm text-[var(--routing-danger)]">{submitError}</p> : null}
        </Card>
      ) : null}

      {step === 3 && selectedAssignment ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setStep(2)}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          <Button
            className="min-h-[44px] flex-1 bg-[var(--routing-teal)] hover:opacity-90"
            onClick={() => {
              setSubmitError(null);
              if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
                setSubmitError("End time must be after start time.");
                return;
              }
              setStep(4);
            }}
          >
            Continue
          </Button>
        </div>
      ) : null}

      {step === 4 && selectedAssignment ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setStep(3)}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          <Button
            className="min-h-[44px] flex-1 bg-[var(--routing-teal)] hover:opacity-90"
            loading={submitting}
            onClick={handleConfirm}
          >
            {submitting ? "Scheduling…" : "Confirm and schedule"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
