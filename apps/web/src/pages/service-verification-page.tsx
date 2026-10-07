import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Hand,
  LockKeyhole,
  PenLine,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Button, Card, StatusBadge, cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { SignaturePad } from "@/components/signature-pad";
import {
  newIdempotencyKey,
  type ActiveVisit,
  type AssignedClient,
  type AuthorizedService,
  type ScheduledShift,
  type VisitResult,
} from "@/lib/sv-backend";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import {
  formatClockTime,
  formatDuration,
  formatElapsed,
  formatScheduledWindow,
  formatVisitDate,
  formatScheduledTime,
  type VisitSignerRole,
} from "@/lib/service-verification";




interface EndedVisit {
  timeIn: string;
  timeOut: string;
  workedMinutes: number;
  clientCode: string;
  serviceCode: string;
  serviceName: string;
  visitNumber: string | null;
  scheduledStartsAt: string | null;
  scheduledEndsAt: string | null;
  timeOutEnteredByManager: boolean;
}


type Phase = "loading" | "select" | "active" | "confirm" | "success";
type ConfirmationMode = "signature" | "exception";
type SignatureKind = "signature" | "assisted_mark";

const NO_SIGNER_REASONS = [
  "Technical problem prevented signing",
  "Signature was accidentally missed before departure",
] as const;

function normalizeError(cause: unknown, fallback: string) {
  const message =
    cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : fallback;
  return message
    .replace(/^NO_SCHEDULED_VISIT:\s*/i, "")
    .replace(/^MULTIPLE_SCHEDULED_VISITS:\s*/i, "")
    .replace(/^NOT_FOUND:\s*/i, "")
    .replace(/^RATE_LIMITED:\s*/i, "");
}

function serviceCountLabel(count: number) {
  return `${count} active service${count === 1 ? "" : "s"}`;
}

// The caregiver's entry list. "Scheduled today" comes from the server: the
// next_scheduled_* window is only set for the caller's own, not-called-out
// shift on the organization's current local date (both backends).
function ClientChoiceList({
  heading,
  emptyText,
  clients,
  selectedClientId,
  onChoose,
}: {
  heading: string;
  emptyText?: string;
  clients: AssignedClient[];
  selectedClientId: string;
  onChoose: (clientId: string) => void;
}) {
  const headingId = `client-list-${heading.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div>
      <h2
        id={headingId}
        className="text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        {heading}
      </h2>
      {clients.length === 0 && emptyText ? (
        <p className="mt-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
          {emptyText}
        </p>
      ) : (
        <ul className="mt-2 space-y-2" aria-labelledby={headingId}>
          {clients.map((client) => {
            const selected = client.client_id === selectedClientId;
            return (
              <li key={client.client_id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChoose(client.client_id)}
                  className={cn(
                    "flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left",
                    selected
                      ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-200"
                      : "border-slate-200 bg-white hover:border-slate-300",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-950">
                      Client {client.client_code}
                    </span>
                    <span className="block text-sm text-slate-600">
                      {client.next_scheduled_starts_at
                        ? formatScheduledWindow(
                            client.next_scheduled_starts_at,
                            client.next_scheduled_ends_at,
                          )
                        : "Not scheduled today"}
                      {" · "}
                      {serviceCountLabel(client.active_service_count)}
                    </span>
                  </span>
                  {selected ? (
                    <Check
                      className="h-5 w-5 shrink-0 text-indigo-600"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BrandHeader({
  agencyName,
  logoUrl,
  status,
}: {
  agencyName: string;
  logoUrl: string | null | undefined;
  status: "Ready" | "Visit in progress" | "Client confirmation" | "Saved";
}) {
  const initials = agencyName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="h-11 w-11 rounded-xl object-contain"
          />
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent,#4f46e5)] text-sm font-bold text-white shadow-sm">
            {initials || "SC"}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-bold text-slate-950">{agencyName}</p>
          <p className="truncate text-xs text-slate-500">
            Visit Verification · Verificación de Visita
          </p>
        </div>
      </div>
      <StatusBadge
        label={status}
        tone={
          status === "Visit in progress" || status === "Saved"
            ? "success"
            : status === "Client confirmation"
              ? "warning"
              : "info"
        }
      />
    </header>
  );
}

function Progress({ phase }: { phase: Phase }) {
  const current =
    phase === "select" || phase === "loading" ? 0 : phase === "active" ? 1 : 2;
  const complete = phase === "success";
  return (
    <div
      className="grid grid-cols-3 gap-2 border-b border-slate-200 pb-4"
      aria-label="Visit progress"
    >
      {["Start", "Visit", "Confirm"].map((label, index) => {
        const done = complete || index < current;
        const selected = !complete && index === current;
        const selectedStyles = [
          "bg-indigo-600 text-white ring-indigo-100",
          "bg-emerald-600 text-white ring-emerald-100",
          "bg-violet-600 text-white ring-violet-100",
        ];
        return (
          <div key={label} className="text-center">
            <div
              className={cn(
                "mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                done
                  ? "bg-emerald-600 text-white ring-4 ring-emerald-100"
                  : selected
                    ? `${selectedStyles[index]} ring-4`
                    : "bg-sky-50 text-sky-600 ring-2 ring-sky-100",
              )}
            >
              {done ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <p
              className={cn(
                "mt-1 text-xs",
                selected
                  ? "font-bold text-slate-900"
                  : done
                    ? "font-semibold text-emerald-700"
                    : "text-sky-700",
              )}
            >
              {label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function ServiceVerificationPage() {
  const { user } = useAuth();
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const backend = useServiceVerificationBackend();

  const [phase, setPhase] = useState<Phase>("loading");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [endedVisit, setEndedVisit] = useState<EndedVisit | null>(null);
  const [confirmationMode, setConfirmationMode] =
    useState<ConfirmationMode>("signature");
  const [signerRole, setSignerRole] = useState<VisitSignerRole>("client");
  const [signatureKind, setSignatureKind] =
    useState<SignatureKind>("signature");
  const [signature, setSignature] = useState<string | null>(null);
  const [noSignerReason, setNoSignerReason] = useState("");
  const [noSignerNote, setNoSignerNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [result, setResult] = useState<VisitResult | null>(null);
  // One key per intended action: retries of the same submission (double tap,
  // ambiguous network failure) reuse it so the server applies it once; any
  // change to what is being submitted gets a new key.
  const startKey = useRef(newIdempotencyKey());
  const confirmKey = useRef(newIdempotencyKey());
  const scheduledServiceAppliedFor = useRef<string | null>(null);

  const activeVisitQuery = useQuery({
    queryKey: ["active-service-visit-v3", activeOrganizationId],
    queryFn: (): Promise<ActiveVisit | null> =>
      backend.getActiveVisit(activeOrganizationId!),
    enabled: !!user && !!activeOrganizationId,
  });

  const clientsQuery = useQuery({
    queryKey: ["assigned-visit-clients", activeOrganizationId],
    queryFn: (): Promise<AssignedClient[]> =>
      backend.listAssignedClients(activeOrganizationId!),
    enabled: !!user && !!activeOrganizationId && phase === "select",
  });

  const scheduledToday = useMemo(
    () =>
      (clientsQuery.data ?? []).filter(
        (client) => !!client.next_scheduled_starts_at,
      ),
    [clientsQuery.data],
  );
  const notScheduledToday = useMemo(
    () =>
      (clientsQuery.data ?? []).filter(
        (client) => !client.next_scheduled_starts_at,
      ),
    [clientsQuery.data],
  );

  const selectedClient = useMemo(
    () =>
      (clientsQuery.data ?? []).find(
        (client) => client.client_id === selectedClientId,
      ) ?? null,
    [clientsQuery.data, selectedClientId],
  );

  const servicesQuery = useQuery({
    queryKey: [
      "authorized-visit-services",
      activeOrganizationId,
      selectedClientId,
    ],
    queryFn: (): Promise<AuthorizedService[]> =>
      backend.listAuthorizedServices(activeOrganizationId!, selectedClientId),
    enabled: !!activeOrganizationId && !!selectedClientId && phase === "select",
  });

  const scheduledService = useMemo(
    () =>
      (servicesQuery.data ?? []).find(
        (service) =>
          !!selectedClient?.next_scheduled_service_id &&
          service.service_id === selectedClient.next_scheduled_service_id,
      ) ?? null,
    [selectedClient, servicesQuery.data],
  );

  const shiftsQuery = useQuery({
    queryKey: [
      "scheduled-shifts-for-visit",
      activeOrganizationId,
      selectedClientId,
    ],
    queryFn: (): Promise<ScheduledShift[]> =>
      backend.listScheduledShifts!(activeOrganizationId!, selectedClientId),
    // Only back ends that can list shifts offer the picker; others link the shift on the server.
    enabled:
      !!backend.listScheduledShifts &&
      !!activeOrganizationId &&
      !!selectedClientId &&
      phase === "select",
  });

  const selectedService = useMemo(
    () =>
      (servicesQuery.data ?? []).find(
        (service) => service.service_id === selectedServiceId,
      ) ?? null,
    [selectedServiceId, servicesQuery.data],
  );

  const active = activeVisitQuery.data;
  const elapsedSeconds = active
    ? Math.max(0, (nowTick - new Date(active.time_in).getTime()) / 1000)
    : 0;
  const projectedMinutes =
    (active?.confirmed_minutes_this_month ?? 0) + elapsedSeconds / 60;
  const authorizationMinutes = Math.round(
    Number(active?.max_monthly_hours ?? 0) * 60,
  );
  const remainingMinutes = Math.max(
    0,
    authorizationMinutes - (active?.confirmed_minutes_this_month ?? 0),
  );
  const willExceed = !!active && projectedMinutes > authorizationMinutes;

  useEffect(() => {
    startKey.current = newIdempotencyKey();
  }, [selectedClientId, selectedServiceId]);

  useEffect(() => {
    confirmKey.current = newIdempotencyKey();
  }, [
    visitId,
    confirmationMode,
    signerRole,
    signatureKind,
    signature,
    noSignerReason,
    noSignerNote,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (
      activeVisitQuery.isLoading ||
      activeVisitQuery.isError ||
      phase === "success"
    )
      return;
    const visit = activeVisitQuery.data;
    if (!visit) {
      if (phase === "loading") setPhase("select");
      return;
    }

    setVisitId(visit.visit_id);
    if (
      visit.visit_status === "awaiting_signature" &&
      visit.time_out &&
      visit.worked_minutes
    ) {
      setEndedVisit({
        timeIn: visit.time_in,
        timeOut: visit.time_out,
        workedMinutes: visit.worked_minutes,
        clientCode: visit.client_code,
        serviceCode: visit.service_code,
        serviceName: visit.service_name,
        visitNumber: visit.visit_number,
        scheduledStartsAt: visit.scheduled_starts_at,
        scheduledEndsAt: visit.scheduled_ends_at,
        timeOutEnteredByManager: !!visit.time_out_entered_by_manager,
      });
      setPhase("confirm");
    } else if (phase === "loading" || phase === "select") {
      setPhase("active");
    }
  }, [
    activeVisitQuery.data,
    activeVisitQuery.isError,
    activeVisitQuery.isLoading,
    phase,
  ]);

  useEffect(() => {
    const services = servicesQuery.data ?? [];
    if (services.length === 1) setSelectedServiceId(services[0]!.service_id);
    // Several services: start on the one the caregiver is scheduled for
    // today (once per client, so a deliberate change is not overridden).
    const scheduled = selectedClient?.next_scheduled_service_id;
    if (
      services.length > 1 &&
      selectedClient &&
      scheduledServiceAppliedFor.current !== selectedClient.client_id &&
      scheduled &&
      services.some((service) => service.service_id === scheduled)
    ) {
      scheduledServiceAppliedFor.current = selectedClient.client_id;
      setSelectedServiceId(scheduled);
      return;
    }
    if (
      services.length !== 1 &&
      !services.some((service) => service.service_id === selectedServiceId)
    ) {
      setSelectedServiceId("");
    }
  }, [selectedClient, selectedServiceId, servicesQuery.data]);

  useEffect(() => {
    const shifts = shiftsQuery.data ?? [];
    if (shifts.length === 1) setSelectedShiftId(shifts[0]!.shift_id);
    if (
      shifts.length !== 1 &&
      !shifts.some((shift) => shift.shift_id === selectedShiftId)
    ) {
      setSelectedShiftId(null);
    }
  }, [selectedShiftId, shiftsQuery.data]);

  function invalidateVisitData() {
    void queryClient.invalidateQueries({
      queryKey: ["active-service-visit-v3", activeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["assigned-visit-clients", activeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["authorized-visit-services", activeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["service-visit-report", activeOrganizationId],
    });
  }

  function chooseClient(clientId: string) {
    scheduledServiceAppliedFor.current = null;
    setSelectedClientId(clientId);
    setSelectedServiceId("");
    setError(null);
  }

  async function startVisit() {
    if (!activeOrganizationId || !selectedClient || !selectedService || saving)
      return;
    setSaving(true);
    setError(null);
    try {
      const data = await backend.startVisit({
        organizationId: activeOrganizationId,
        clientId: selectedClient.client_id,
        serviceId: selectedService.service_id,
        scheduledShiftId: selectedShiftId,
        idempotencyKey: startKey.current,
      });
      if (data) setVisitId(data);
      invalidateVisitData();
      const refreshed = await activeVisitQuery.refetch();
      if (!refreshed.data)
        throw new Error(
          "The visit started, but its timer could not be loaded. Refresh this page.",
        );
      setPhase("active");
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be started."));
    } finally {
      setSaving(false);
    }
  }

  async function endVisit() {
    if (!visitId || !active || saving) return;
    setSaving(true);
    setError(null);
    try {
      const ended = await backend.endVisit(visitId);
      setEndedVisit({
        timeIn: ended.time_in,
        timeOut: ended.time_out,
        workedMinutes: ended.worked_minutes,
        clientCode: active.client_code,
        serviceCode: active.service_code,
        serviceName: active.service_name,
        visitNumber: active.visit_number,
        scheduledStartsAt: active.scheduled_starts_at,
        scheduledEndsAt: active.scheduled_ends_at,
        timeOutEnteredByManager: false,
      });
      setConfirmationMode("signature");
      setSignatureKind("signature");
      invalidateVisitData();
      setPhase("confirm");
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be ended."));
    } finally {
      setSaving(false);
    }
  }

  function exceptionExplanation() {
    return [noSignerReason.trim(), noSignerNote.trim()]
      .filter(Boolean)
      .join(": ");
  }

  async function submitConfirmation() {
    if (!visitId || !activeOrganizationId || saving) return;
    if (confirmationMode === "signature" && !signature) return;
    if (confirmationMode === "exception" && !noSignerReason) return;

    setSaving(true);
    setError(null);
    try {
      const confirmed: VisitResult = await backend.confirmVisit({
        organizationId: activeOrganizationId,
        visitId,
        signerRole,
        method:
          confirmationMode === "signature"
            ? signatureKind === "assisted_mark"
              ? "assisted_mark"
              : "draw"
            : "unable_to_confirm",
        signatureDataUrl: confirmationMode === "signature" ? signature : null,
        reason:
          confirmationMode === "exception" ? exceptionExplanation() : null,
        idempotencyKey: confirmKey.current,
      });
      setResult(confirmed);
      setPhase("success");
      invalidateVisitData();
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be submitted."));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setPhase("select");
    setSelectedClientId("");
    setSelectedServiceId("");
    setSelectedShiftId(null);
    setVisitId(null);
    setEndedVisit(null);
    setConfirmationMode("signature");
    setSignerRole("client");
    setSignatureKind("signature");
    setSignature(null);
    setNoSignerReason("");
    setNoSignerNote("");
    setResult(null);
    setError(null);
    void activeVisitQuery.refetch();
  }

  if (!user) {
    return (
      <p className="text-sm text-slate-500">
        Sign in to use Service Verification.
      </p>
    );
  }

  if (activeVisitQuery.isError) {
    return (
      <Card className="mx-auto max-w-md rounded-3xl p-5">
        <BrandHeader
          agencyName={activeOrganization?.displayName ?? "SoCal Care Services"}
          logoUrl={activeOrganization?.logoUrl}
          status="Ready"
        />
        <div
          role="alert"
          className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <p className="font-semibold">
            The sign-in sheet could not safely check for an open visit.
          </p>
          <p className="mt-1">
            Refresh the page or contact your agency manager. Do not start a
            second visit.
          </p>
        </div>
      </Card>
    );
  }

  const headerStatus =
    phase === "active"
      ? "Visit in progress"
      : phase === "confirm"
        ? "Client confirmation"
        : phase === "success"
          ? "Saved"
          : "Ready";

  return (
    <div className="mx-auto max-w-md pb-20">
      <Card className="overflow-hidden rounded-3xl border-slate-200 p-5 shadow-sm sm:p-6">
        <div className="space-y-5">
          <BrandHeader
            agencyName={
              activeOrganization?.displayName ?? "SoCal Care Services"
            }
            logoUrl={activeOrganization?.logoUrl}
            status={headerStatus}
          />
          <Progress phase={phase} />

          {error ? (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
            >
              {error}
            </div>
          ) : null}

          {phase === "loading" ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Loading your visit…
            </p>
          ) : null}

          {phase === "select" ? (
            <section
              className="space-y-5"
              aria-labelledby="select-visit-heading"
            >
              <div>
                <h1
                  id="select-visit-heading"
                  className="text-xl font-semibold text-slate-950"
                >
                  Today's visits
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  {formatVisitDate(new Date(nowTick).toISOString())} · Only
                  clients assigned to you are shown.
                </p>
              </div>

              {clientsQuery.isLoading ? (
                <p className="text-sm text-slate-500">Loading your visits…</p>
              ) : null}
              {clientsQuery.isError ? (
                <p
                  role="alert"
                  className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                >
                  Your visits could not be loaded. Refresh the page or contact
                  your agency manager.
                </p>
              ) : null}
              {clientsQuery.isSuccess && clientsQuery.data.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-semibold">
                    No assigned clients are available.
                  </p>
                  <p className="mt-1">
                    Ask your agency manager to check your client and service
                    assignments.
                  </p>
                </div>
              ) : null}

              {clientsQuery.isSuccess && clientsQuery.data.length > 0 ? (
                <div className="space-y-4">
                  <ClientChoiceList
                    heading="Scheduled today"
                    emptyText="You have no visits scheduled for today."
                    clients={scheduledToday}
                    selectedClientId={selectedClientId}
                    onChoose={chooseClient}
                  />
                  {notScheduledToday.length > 0 ? (
                    <ClientChoiceList
                      heading="Other assigned clients"
                      clients={notScheduledToday}
                      selectedClientId={selectedClientId}
                      onChoose={chooseClient}
                    />
                  ) : null}
                </div>
              ) : null}

              {selectedClient ? (
                <div
                  className="rounded-3xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-4 text-sm text-indigo-950 shadow-sm"
                  aria-label="Visit details"
                  role="group"
                >
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                    <dt className="text-slate-500">Client</dt>
                    <dd className="font-semibold">
                      {selectedClient.client_code}
                    </dd>
                    <dt className="text-slate-500">Service</dt>
                    <dd className="min-w-0 break-words font-semibold">
                      {servicesQuery.isLoading
                        ? "Loading…"
                        : selectedService
                          ? `${selectedService.service_code} · ${selectedService.service_name}`
                          : (servicesQuery.data?.length ?? 0) > 1
                            ? "Choose below"
                            : "—"}
                    </dd>
                    <dt className="text-slate-500">Date</dt>
                    <dd className="font-semibold">
                      {formatVisitDate(
                        selectedClient.next_scheduled_starts_at ??
                          new Date(nowTick).toISOString(),
                      )}
                    </dd>
                    <dt className="text-slate-500">Scheduled</dt>
                    <dd className="font-semibold">
                      {formatScheduledWindow(
                        selectedClient.next_scheduled_starts_at,
                        selectedClient.next_scheduled_ends_at,
                      )}
                    </dd>
                  </dl>
                  {!selectedClient.next_scheduled_starts_at ? (
                    <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                      This client is not on your schedule today. Start only if
                      your manager asked you to.
                    </p>
                  ) : null}

                  {(servicesQuery.data?.length ?? 0) > 1 ? (
                    <label className="mt-4 block text-sm font-semibold text-slate-700">
                      Service for this visit
                      <span className="mt-1 block text-xs font-normal text-slate-500">
                        {scheduledService
                          ? `Scheduled today: ${scheduledService.service_code} · ${scheduledService.service_name}. Change it only if you are providing a different service.`
                          : `This client has ${servicesQuery.data!.length} active services. Choose the one you are providing.`}
                      </span>
                      <select
                        aria-label="Service for this visit"
                        value={selectedServiceId}
                        onChange={(event) =>
                          setSelectedServiceId(event.target.value)
                        }
                        className="mt-2 min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950"
                      >
                        <option value="">Choose a service</option>
                        {(servicesQuery.data ?? []).map((service) => (
                          <option
                            key={service.service_id}
                            value={service.service_id}
                          >
                            {service.service_code} · {service.service_name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {scheduledService &&
                  selectedService &&
                  selectedService.service_id !== scheduledService.service_id ? (
                    <p
                      role="status"
                      className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900"
                    >
                      This is not the scheduled service. The visit will not
                      be linked to today's scheduled visit.
                    </p>
                  ) : null}

                  {selectedService ? (
                    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-2xl border border-indigo-100 bg-indigo-100/70 p-2 text-indigo-950">
                        <p className="text-base font-bold">
                          {formatDuration(
                            Number(selectedService.max_monthly_hours) * 60,
                          )}
                        </p>
                        <p className="text-[11px] text-indigo-800">
                          Authorized
                        </p>
                      </div>
                      <div className="rounded-2xl border border-sky-100 bg-sky-100/80 p-2 text-sky-950">
                        <p className="text-base font-bold">
                          {formatDuration(
                            Number(selectedService.hours_used_this_month) * 60,
                          )}
                        </p>
                        <p className="text-[11px] text-indigo-800">Serviced</p>
                      </div>
                      <div className="rounded-2xl border border-emerald-100 bg-emerald-100/80 p-2 text-emerald-950">
                        <p className="text-base font-bold">
                          {formatDuration(
                            Math.max(
                              0,
                              Number(
                                selectedService.max_monthly_hours -
                                  selectedService.hours_used_this_month,
                              ),
                            ) * 60,
                          )}
                        </p>
                        <p className="text-[11px] text-indigo-800">Remaining</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {servicesQuery.isError ? (
                <p
                  role="alert"
                  className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                >
                  Services could not be loaded. Contact your agency manager.
                </p>
              ) : null}
              {selectedClient &&
              servicesQuery.isSuccess &&
              servicesQuery.data.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-semibold">
                    No active service authorization is available for Client{" "}
                    {selectedClient.client_code}.
                  </p>
                  <p className="mt-1">
                    A manager must add, renew, or assign the correct service
                    before you can start.
                  </p>
                </div>
              ) : null}

              {shiftsQuery.isLoading ? (
                <p className="text-sm text-slate-500">
                  Loading scheduled shifts…
                </p>
              ) : null}
              {shiftsQuery.isError ? (
                <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  Scheduled shifts could not be loaded. Contact your agency
                  manager.
                </p>
              ) : null}

              {(shiftsQuery.data?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <label className="block text-sm font-semibold text-slate-700">
                    Scheduled shift for today
                    {(shiftsQuery.data?.length ?? 0) > 1 ? (
                      <span className="mt-1 block text-xs font-normal text-slate-500">
                        Multiple shifts available. Select the one you are
                        starting.
                      </span>
                    ) : null}
                  </label>
                  <div className="space-y-2">
                    {(shiftsQuery.data ?? []).map((shift) => (
                      <button
                        key={shift.shift_id}
                        type="button"
                        onClick={() => {
                          setSelectedShiftId(shift.shift_id);
                          setSelectedServiceId(shift.service_id);
                        }}
                        className={cn(
                          "w-full rounded-2xl border-2 p-3 text-left transition-colors",
                          selectedShiftId === shift.shift_id
                            ? "border-indigo-600 bg-indigo-50"
                            : "border-slate-200 bg-white hover:border-slate-300",
                        )}
                      >
                        <p className="font-semibold text-slate-950">
                          {formatScheduledTime(shift.starts_at, shift.ends_at)}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {shift.service_code} · {shift.service_name}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedService && !shiftsQuery.isLoading ? (
                <div className="rounded-3xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-4 text-sm text-indigo-950 shadow-sm">
                  <p className="font-semibold">
                    {selectedService.service_code} ·{" "}
                    {selectedService.service_name}
                  </p>
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between rounded-2xl border border-indigo-100 bg-indigo-100/70 p-2">
                      <p className="text-xs text-indigo-800">Authorized</p>
                      <p className="text-sm font-bold text-indigo-950">
                        {formatDuration(
                          Number(selectedService.max_monthly_hours) * 60,
                        )}
                      </p>
                    </div>
                    <div className="flex items-center justify-between rounded-2xl border border-sky-100 bg-sky-100/80 p-2">
                      <p className="text-xs text-sky-800">Used this month</p>
                      <p className="text-sm font-bold text-sky-950">
                        {formatDuration(
                          Number(selectedService.hours_used_this_month) * 60,
                        )}
                      </p>
                    </div>
                    <div className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-emerald-100/80 p-2">
                      <p className="text-xs text-emerald-800">Remaining</p>
                      <p className="text-sm font-bold text-emerald-950">
                        {formatDuration(
                          Math.max(
                            0,
                            Number(
                              selectedService.max_monthly_hours -
                                selectedService.hours_used_this_month,
                            ),
                          ) * 60,
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="rounded-2xl bg-slate-50 p-4 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Current Pacific time
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">
                  {formatClockTime(new Date(nowTick).toISOString())}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatVisitDate(new Date(nowTick).toISOString())} · automatic
                  server timestamp
                </p>
              </div>

              <Button
                type="button"
                className="min-h-14 w-full bg-emerald-600 text-base font-bold text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700"
                disabled={!selectedClient || !selectedService || saving}
                loading={saving}
                onClick={startVisit}
              >
                Start visit · Iniciar visita
              </Button>
              <p className="text-center text-xs text-slate-500">
                Time In is recorded by the server when you tap Start.
              </p>
            </section>
          ) : null}

          {phase === "active" && active ? (
            <section
              className="space-y-5"
              aria-labelledby="active-visit-heading"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h1
                    id="active-visit-heading"
                    className="text-xl font-semibold text-slate-950"
                  >
                    Visit in progress
                  </h1>
                  <p className="mt-1 text-sm text-slate-500">
                    Client and service are locked.
                  </p>
                </div>
                <span className="flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-2 text-sm font-extrabold uppercase tracking-wide text-emerald-800 ring-2 ring-emerald-200">
                  <span className="h-3 w-3 animate-pulse rounded-full bg-emerald-600 ring-4 ring-emerald-200" />{" "}
                  Live
                </span>
              </div>

              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Client
                  </p>
                  <p className="mt-1 text-lg font-bold text-slate-950">
                    {active.client_code}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Service
                  </p>
                  <p className="mt-1 text-lg font-bold text-slate-950">
                    {active.service_code} · {active.service_name}
                  </p>
                </div>
                {active.scheduled_starts_at && active.scheduled_ends_at ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Scheduled shift
                    </p>
                    <p className="mt-1 text-lg font-bold text-slate-950">
                      {formatScheduledTime(
                        active.scheduled_starts_at,
                        active.scheduled_ends_at,
                      )}
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="mx-auto flex h-56 w-56 flex-col items-center justify-center rounded-full border-8 border-sky-100 bg-gradient-to-br from-white to-sky-50 text-center shadow-xl shadow-sky-100/70 ring-4 ring-sky-50">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Time In
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">
                  {formatClockTime(active.time_in)}
                </p>
                <p className="mt-2 rounded-full bg-sky-100 px-3 py-1 font-mono text-sm font-bold tabular-nums text-sky-800">
                  {formatElapsed(elapsedSeconds)} elapsed
                </p>
              </div>

              <p className="text-center text-sm text-slate-600">
                {active.scheduled_starts_at ? "Scheduled shift: " : ""}
                <span className="font-semibold text-slate-900">
                  {formatScheduledWindow(
                    active.scheduled_starts_at,
                    active.scheduled_ends_at,
                  )}
                </span>
              </p>

              {willExceed ? (
                <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p>
                    This visit is projected to exceed the authorization. The
                    full time will be recorded and sent to a manager for review.
                  </p>
                </div>
              ) : (
                <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-center shadow-sm">
                  <p className="text-3xl font-extrabold tabular-nums text-emerald-800">
                    {formatDuration(remainingMinutes)}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-emerald-900">
                    Authorized time remaining this month
                  </p>
                </div>
              )}

              <Button
                type="button"
                className="min-h-14 w-full bg-rose-600 text-base font-bold text-white shadow-lg shadow-rose-100 hover:bg-rose-700"
                loading={saving}
                onClick={endVisit}
              >
                End visit · Terminar visita
              </Button>
              <p className="text-center text-xs text-slate-500">
                The sign-in sheet records Time Out automatically. A manager can
                correct a mistake without deleting the original.
              </p>
            </section>
          ) : null}

          {phase === "confirm" && endedVisit ? (
            <section
              className="space-y-5"
              aria-labelledby="confirm-visit-heading"
            >
              <div>
                <h1
                  id="confirm-visit-heading"
                  className="text-xl font-semibold text-slate-950"
                >
                  Verify visit details
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  Review before collecting client or guardian confirmation.
                </p>
              </div>

              {endedVisit.timeOutEnteredByManager ? (
                <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p>
                    The Time Out below was entered by your agency because the visit
                    was not signed out. Check it with the client before they confirm.
                  </p>
                </div>
              ) : null}

              <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Client
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {endedVisit.clientCode}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Service
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {endedVisit.serviceCode} · {endedVisit.serviceName}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Date
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {formatVisitDate(endedVisit.timeIn)}
                  </p>
                </div>
                {endedVisit.scheduledStartsAt && endedVisit.scheduledEndsAt ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Scheduled shift
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-950">
                      {formatScheduledWindow(
                        endedVisit.scheduledStartsAt,
                        endedVisit.scheduledEndsAt,
                      )}
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Actual time in
                  </span>
                  <span className="text-sm font-semibold text-slate-950">
                    {formatClockTime(endedVisit.timeIn)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Actual time out
                  </span>
                  <span className="text-sm font-semibold text-slate-950">
                    {formatClockTime(endedVisit.timeOut)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 pt-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Total worked
                  </span>
                  <span className="text-sm font-bold text-slate-950">
                    {formatDuration(endedVisit.workedMinutes)}
                  </span>
                </div>
              </div>

              {confirmationMode === "signature" ? (
                <div className="space-y-4">
                  <label className="block text-sm font-semibold text-slate-700">
                    Person confirming
                    <select
                      aria-label="Person confirming"
                      value={signerRole}
                      onChange={(event) =>
                        setSignerRole(event.target.value as VisitSignerRole)
                      }
                      className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
                    >
                      <option value="client">Client</option>
                      <option value="parent">Parent</option>
                      <option value="guardian">Guardian</option>
                      <option value="authorized_representative">
                        Authorized representative
                      </option>
                    </select>
                  </label>
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      Choose the easiest way to confirm
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Elija la forma más fácil de confirmar.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      aria-pressed={signatureKind === "signature"}
                      onClick={() => {
                        setSignatureKind("signature");
                        setSignature(null);
                      }}
                      className={cn(
                        "flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 p-3 text-sm font-semibold",
                        signatureKind === "signature"
                          ? "border-indigo-600 bg-indigo-50 text-indigo-950"
                          : "border-slate-200 bg-white text-slate-700",
                      )}
                    >
                      <PenLine className="mb-2 h-8 w-8" />
                      Sign name
                      <span className="text-xs font-normal">Firmar</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={signatureKind === "assisted_mark"}
                      onClick={() => {
                        setSignatureKind("assisted_mark");
                        setSignature(null);
                      }}
                      className={cn(
                        "flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 p-3 text-sm font-semibold",
                        signatureKind === "assisted_mark"
                          ? "border-indigo-600 bg-indigo-50 text-indigo-950"
                          : "border-slate-200 bg-white text-slate-700",
                      )}
                    >
                      <Hand className="mb-2 h-8 w-8" />
                      Make a mark
                      <span className="text-xs font-normal">
                        Hacer una marca
                      </span>
                    </button>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-4 text-center">
                    <Hand
                      className="mx-auto h-9 w-9 text-indigo-600"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-semibold text-slate-900">
                      {signatureKind === "assisted_mark"
                        ? "Touch the box and make any mark"
                        : "Use your finger to sign in the box"}
                    </p>
                    <p className="text-sm text-slate-600">
                      {signatureKind === "assisted_mark"
                        ? "Toque el cuadro y haga cualquier marca"
                        : "Use su dedo para firmar en el cuadro"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                    By signing or making a mark, I confirm that the service and
                    times shown above are correct.
                  </div>
                  <SignaturePad key={signatureKind} onChange={setSignature} />
                  <Button
                    type="button"
                    className="min-h-14 w-full text-base"
                    disabled={!signature || saving}
                    loading={saving}
                    onClick={submitConfirmation}
                  >
                    Confirm visit · Confirmar visita
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmationMode("exception");
                      setSignature(null);
                      setError(null);
                    }}
                    className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700"
                  >
                    Unable to obtain confirmation
                  </button>
                </div>
              ) : (
                <div className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex gap-3 text-amber-950">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                    <div>
                      <p className="font-semibold">Submit as unverified</p>
                      <p className="mt-1 text-sm">
                        This will require manager review and will not count as
                        billable time.
                      </p>
                    </div>
                  </div>
                  <label className="block text-sm font-semibold text-amber-950">
                    Why is manager review needed?
                    <select
                      aria-label="Why is manager review needed?"
                      value={noSignerReason}
                      onChange={(event) =>
                        setNoSignerReason(event.target.value)
                      }
                      className="mt-2 min-h-12 w-full rounded-xl border border-amber-300 bg-white px-3 text-base text-slate-950"
                    >
                      <option value="">Choose a reason</option>
                      {NO_SIGNER_REASONS.map((reason) => (
                        <option key={reason}>{reason}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold text-amber-950">
                    Brief explanation (required)
                    <textarea
                      aria-label="Brief explanation"
                      value={noSignerNote}
                      maxLength={500}
                      onChange={(event) => setNoSignerNote(event.target.value)}
                      className="mt-2 min-h-20 w-full rounded-xl border border-amber-300 bg-white p-3 text-base text-slate-950"
                    />
                  </label>
                  <Button
                    type="button"
                    className="min-h-14 w-full text-base"
                    disabled={!noSignerReason || !noSignerNote.trim() || saving}
                    loading={saving}
                    onClick={submitConfirmation}
                  >
                    Submit for manager review
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmationMode("signature");
                      setNoSignerReason("");
                      setNoSignerNote("");
                    }}
                    className="min-h-11 w-full text-sm font-semibold text-amber-950 underline underline-offset-2"
                  >
                    Go back to signature
                  </button>
                </div>
              )}
            </section>
          ) : null}

          {phase === "success" && result && endedVisit ? (
            <section
              className="space-y-5 text-center"
              aria-labelledby="visit-saved-heading"
            >
              <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
              <div>
                <h1
                  id="visit-saved-heading"
                  className="text-2xl font-semibold text-slate-950"
                >
                  {confirmationMode === "exception"
                    ? "Saved for manager review"
                    : "Visit saved"}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  {confirmationMode === "exception"
                    ? "No client confirmation was recorded. The visit is not counted as confirmed or billable."
                    : result.billable_minutes < result.worked_minutes
                      ? "Client confirmation was recorded. The full worked time is preserved, and the authorization difference is flagged for manager review."
                      : "Included in the weekly report and monthly hours calendar."}
                </p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-left text-sm">
                <p className="font-semibold text-slate-950">
                  Client {endedVisit.clientCode} · {endedVisit.serviceName}
                </p>
                <p className="mt-1 text-slate-600">
                  {formatClockTime(endedVisit.timeIn)}–
                  {formatClockTime(endedVisit.timeOut)} ·{" "}
                  {formatDuration(endedVisit.workedMinutes)}
                </p>
                {endedVisit.visitNumber ? (
                  <p className="mt-1 text-xs text-slate-400">
                    {endedVisit.visitNumber}
                  </p>
                ) : null}
              </div>
              <StatusBadge
                label={
                  result.status === "administrator_review"
                    ? "Manager review"
                    : "Confirmed"
                }
                tone={
                  result.status === "administrator_review"
                    ? "warning"
                    : "success"
                }
              />
              <dl
                aria-label="Visit result"
                className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-200 p-4 text-left text-sm"
              >
                <dt className="text-slate-500">Worked</dt>
                <dd className="font-semibold text-slate-950">
                  {formatDuration(result.worked_minutes)}
                </dd>
                <dt className="text-slate-500">Billable</dt>
                <dd className="font-semibold text-slate-950">
                  {formatDuration(result.billable_minutes)}
                </dd>
                <dt className="text-slate-500">Billing</dt>
                <dd className="font-semibold text-slate-950">
                  {result.status === "signed"
                    ? "Billing ready"
                    : "Needs manager review"}
                </dd>
                <dd className="col-span-2 text-xs text-slate-500">
                  {result.status === "signed"
                    ? "Billing ready does not mean billed. The agency reviews and approves billing separately."
                    : "Not billable until a manager reviews it."}
                </dd>
              </dl>
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4 text-left text-xs text-slate-600">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  The caregiver cannot edit this record. A manager correction
                  keeps the original time, the reason, and who made the change.
                </p>
              </div>
              <Button type="button" className="min-h-12 w-full" onClick={reset}>
                Start next visit
              </Button>
            </section>
          ) : null}

          <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-slate-100 pt-4 text-center text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" /> Server timestamps
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Audit protected
            </span>
          </footer>
        </div>
      </Card>
    </div>
  );
}
