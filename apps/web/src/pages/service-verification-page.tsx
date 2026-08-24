import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Button, Card, StatusBadge, cn } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import {
  formatClockTime,
  formatElapsed,
  formatHours,
  formatVisitDate,
  type ServiceVisitStatus,
  type VisitAuthorizationStatus,
  type VisitSignerRole,
} from "@/lib/service-verification";

interface AssignedClient {
  client_id: string;
  client_code: string;
  next_scheduled_starts_at: string | null;
  next_scheduled_ends_at: string | null;
  active_service_count: number;
}

interface AuthorizedService {
  service_id: string;
  service_code: string;
  service_name: string;
  service_color: string | null;
  authorization_id: string;
  max_monthly_hours: number;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
}

interface ActiveVisit {
  visit_id: string;
  visit_number: string | null;
  client_code: string;
  service_code: string;
  service_name: string;
  scheduled_starts_at: string | null;
  scheduled_ends_at: string | null;
  time_in: string;
  time_out: string | null;
  worked_minutes: number | null;
  visit_status: "draft" | "awaiting_signature";
  max_monthly_hours: number;
  confirmed_minutes_this_month: number;
}

interface EndedVisit {
  timeIn: string;
  timeOut: string;
  workedMinutes: number;
  clientCode: string;
  serviceCode: string;
  serviceName: string;
  visitNumber: string | null;
}

interface VisitResult {
  status: ServiceVisitStatus;
  authorization_status: VisitAuthorizationStatus;
  worked_minutes: number;
  billable_minutes: number;
  month_to_date_minutes: number;
  remaining_minutes: number;
}

type Phase = "loading" | "select" | "active" | "confirm" | "success";
type ConfirmationMode = "signature" | "exception";

const NO_SIGNER_REASONS = [
  "Client or guardian unavailable",
  "Client or guardian declined",
  "Client or guardian unable to sign",
  "Technical problem",
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

function serviceSummary(service: AuthorizedService) {
  const used = Number(service.hours_used_this_month);
  const scheduled = Number(service.hours_scheduled_this_month);
  return `${formatHours(used * 60)}h confirmed · ${formatHours(scheduled * 60)}h scheduled · ${formatHours(
    Number(service.max_monthly_hours) * 60,
  )}h authorized`;
}

function clientOptionLabel(client: AssignedClient) {
  const schedule = client.next_scheduled_starts_at
    ? ` · Today ${formatClockTime(client.next_scheduled_starts_at)}`
    : "";
  const services = `${client.active_service_count} active service${client.active_service_count === 1 ? "" : "s"}`;
  return `Client ${client.client_code}${schedule} · ${services}`;
}

function SignaturePad({
  onChange,
}: {
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
    canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
    const context = canvas.getContext("2d");
    context?.scale(ratio, ratio);
    if (context) {
      context.lineWidth = 3;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#312e81";
    }
  }, []);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const context = event.currentTarget.getContext("2d");
    const next = point(event);
    context?.beginPath();
    context?.moveTo(next.x, next.y);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    const next = point(event);
    context?.lineTo(next.x, next.y);
    context?.stroke();
    hasInk.current = true;
  }

  function stop(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasInk.current) onChange(event.currentTarget.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    onChange(null);
  }

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border-2 border-slate-300 bg-white focus-within:border-[var(--color-accent,#4f46e5)]">
        <canvas
          ref={canvasRef}
          aria-label="Client or guardian signature"
          className="block h-40 w-full touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <button
        type="button"
        onClick={clear}
        className="mt-2 min-h-11 text-sm font-semibold text-slate-600 underline underline-offset-2"
      >
        Clear signature
      </button>
    </div>
  );
}

function BrandHeader({
  logoUrl,
  status,
}: {
  logoUrl: string | null | undefined;
  status: "Ready" | "Visit in progress" | "Client confirmation" | "Saved";
}) {
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
            OV
          </div>
        )}
        <div className="min-w-0">
          <p className="font-bold tracking-[0.16em] text-slate-950">OGEVIA</p>
          <p className="truncate text-xs text-slate-500">
            Service verification · Not EVV
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
      {["Select", "Visit", "Confirm"].map((label, index) => {
        const done = complete || index < current;
        const selected = !complete && index === current;
        return (
          <div key={label} className="text-center">
            <div
              className={cn(
                "mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                done || selected
                  ? "bg-[var(--color-accent,#4f46e5)] text-white"
                  : "bg-slate-100 text-slate-400",
              )}
            >
              {done ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <p
              className={cn(
                "mt-1 text-xs",
                selected ? "font-semibold text-slate-900" : "text-slate-500",
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

  const [phase, setPhase] = useState<Phase>("loading");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [visitId, setVisitId] = useState<string | null>(null);
  const [endedVisit, setEndedVisit] = useState<EndedVisit | null>(null);
  const [confirmationMode, setConfirmationMode] =
    useState<ConfirmationMode>("signature");
  const [signerRole, setSignerRole] = useState<VisitSignerRole>("client");
  const [signature, setSignature] = useState<string | null>(null);
  const [noSignerReason, setNoSignerReason] = useState("");
  const [noSignerNote, setNoSignerNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [result, setResult] = useState<VisitResult | null>(null);

  const activeVisitQuery = useQuery({
    queryKey: ["active-service-visit-v3", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc(
        "get_active_service_visit_v3",
        {
          target_organization_id: activeOrganizationId!,
        },
      );
      if (queryError) throw queryError;
      return ((data ?? [])[0] ?? null) as ActiveVisit | null;
    },
    enabled: !!user && !!activeOrganizationId,
  });

  const clientsQuery = useQuery({
    queryKey: ["assigned-visit-clients", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc(
        "list_assigned_visit_clients",
        {
          target_organization_id: activeOrganizationId!,
        },
      );
      if (queryError) throw queryError;
      return (data ?? []) as AssignedClient[];
    },
    enabled: !!user && !!activeOrganizationId && phase === "select",
  });

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
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc(
        "list_authorized_services_for_client",
        {
          target_organization_id: activeOrganizationId!,
          target_client_id: selectedClientId,
        },
      );
      if (queryError) throw queryError;
      return (data ?? []) as AuthorizedService[];
    },
    enabled: !!activeOrganizationId && !!selectedClientId && phase === "select",
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
    if (
      services.length !== 1 &&
      !services.some((service) => service.service_id === selectedServiceId)
    ) {
      setSelectedServiceId("");
    }
  }, [selectedServiceId, servicesQuery.data]);

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
      const { data, error: startError } = await supabase.rpc(
        "start_ad_hoc_service_visit",
        {
          target_organization_id: activeOrganizationId,
          target_client_id: selectedClient.client_id,
          target_service_id: selectedService.service_id,
          visit_task_categories: [],
          visit_service_notes: null,
        },
      );
      if (startError) throw startError;
      if (typeof data === "string") setVisitId(data);
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
      const { data, error: endError } = await supabase.rpc(
        "end_service_visit",
        {
          target_visit_id: visitId,
          visit_task_categories: [],
          visit_service_notes: null,
        },
      );
      if (endError) throw endError;
      const ended = (Array.isArray(data) ? data[0] : data) as {
        time_in: string;
        time_out: string;
        worked_minutes: number;
      };
      setEndedVisit({
        timeIn: ended.time_in,
        timeOut: ended.time_out,
        workedMinutes: ended.worked_minutes,
        clientCode: active.client_code,
        serviceCode: active.service_code,
        serviceName: active.service_name,
        visitNumber: active.visit_number,
      });
      setConfirmationMode("signature");
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
      let storagePath: string | null = null;
      if (confirmationMode === "signature") {
        const response = await fetch(signature!);
        const blob = await response.blob();
        storagePath = `${activeOrganizationId}/${visitId}/client-signature.png`;
        const { error: uploadError } = await supabase.storage
          .from("visit-signatures")
          .upload(storagePath, blob, {
            contentType: "image/png",
            upsert: true,
          });
        if (uploadError) throw uploadError;
      }

      const { data, error: confirmError } = await supabase.rpc(
        "confirm_service_visit",
        {
          target_visit_id: visitId,
          signer_role: signerRole,
          confirmation_method:
            confirmationMode === "signature" ? "draw" : "unable_to_confirm",
          signature_storage_path: storagePath,
          typed_signer_name: null,
          signer_relationship: null,
          confirmation_reason:
            confirmationMode === "exception" ? exceptionExplanation() : null,
        },
      );
      if (confirmError) throw confirmError;
      const confirmed = (Array.isArray(data) ? data[0] : data) as VisitResult;
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
    setVisitId(null);
    setEndedVisit(null);
    setConfirmationMode("signature");
    setSignerRole("client");
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
        <BrandHeader logoUrl={activeOrganization?.logoUrl} status="Ready" />
        <div
          role="alert"
          className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <p className="font-semibold">
            Ogevia could not safely check for an open visit.
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
                  Select this visit
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  Only clients assigned to you are shown.
                </p>
              </div>

              <label className="block text-sm font-semibold text-slate-700">
                Assigned client
                <select
                  aria-label="Assigned client"
                  value={selectedClientId}
                  onChange={(event) => chooseClient(event.target.value)}
                  className="mt-2 min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950"
                >
                  <option value="">Choose a client</option>
                  {(clientsQuery.data ?? []).map((client) => (
                    <option key={client.client_id} value={client.client_id}>
                      {clientOptionLabel(client)}
                    </option>
                  ))}
                </select>
              </label>

              {clientsQuery.isLoading ? (
                <p className="text-sm text-slate-500">
                  Loading assigned clients…
                </p>
              ) : null}
              {clientsQuery.isError ? (
                <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  Assigned clients could not be loaded. Contact your agency
                  manager.
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

              {selectedClient ? (
                <label className="block text-sm font-semibold text-slate-700">
                  Service for this visit
                  <span className="mt-1 block text-xs font-normal text-slate-500">
                    {(servicesQuery.data?.length ?? 0) > 1
                      ? `This client has ${servicesQuery.data!.length} active services. Choose the exact one.`
                      : "The service must match the work being provided."}
                  </span>
                  <select
                    aria-label="Service for this visit"
                    value={selectedServiceId}
                    onChange={(event) =>
                      setSelectedServiceId(event.target.value)
                    }
                    disabled={
                      servicesQuery.isLoading ||
                      (servicesQuery.data?.length ?? 0) === 0
                    }
                    className="mt-2 min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 disabled:bg-slate-100"
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

              {servicesQuery.isLoading ? (
                <p className="text-sm text-slate-500">
                  Loading authorized services…
                </p>
              ) : null}
              {servicesQuery.isError ? (
                <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
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
                    before sign-in.
                  </p>
                </div>
              ) : null}

              {selectedService ? (
                <div className="rounded-2xl bg-indigo-50 p-4 text-sm text-indigo-950">
                  <p className="font-semibold">
                    {selectedService.service_code} ·{" "}
                    {selectedService.service_name}
                  </p>
                  <p className="mt-1 text-xs text-indigo-800">
                    {serviceSummary(selectedService)}
                  </p>
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
                className="min-h-14 w-full text-base"
                disabled={!selectedClient || !selectedService || saving}
                loading={saving}
                onClick={startVisit}
              >
                Sign in now · Iniciar ahora
              </Button>
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
                <span className="flex items-center gap-2 text-xs font-semibold text-emerald-700">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{" "}
                  Live
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Client
                  </p>
                  <p className="mt-1 font-semibold text-slate-950">
                    Client {active.client_code}
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Service
                  </p>
                  <p className="mt-1 font-semibold text-slate-950">
                    {active.service_code} · {active.service_name}
                  </p>
                </div>
              </div>

              <div className="py-4 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Signed in at
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">
                  {formatClockTime(active.time_in)}
                </p>
                <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-accent,#4f46e5)]">
                  {formatElapsed(elapsedSeconds)} elapsed
                </p>
              </div>

              {active.scheduled_starts_at && active.scheduled_ends_at ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-center text-sm text-slate-600">
                  Scheduled {formatClockTime(active.scheduled_starts_at)}–
                  {formatClockTime(active.scheduled_ends_at)}
                </p>
              ) : null}

              {willExceed ? (
                <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p>
                    This visit is projected to exceed the authorization. The
                    full time will be recorded and sent to a manager for review.
                  </p>
                </div>
              ) : (
                <p className="text-center text-sm text-slate-500">
                  {formatHours(remainingMinutes)} authorized hours remain this
                  month
                </p>
              )}

              <Button
                type="button"
                className="min-h-14 w-full text-base"
                loading={saving}
                onClick={endVisit}
              >
                Sign out now · Finalizar ahora
              </Button>
              <p className="text-center text-xs text-slate-500">
                Ogevia records Time Out automatically. A manager can correct a
                mistake without deleting the original.
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
                  Client or guardian confirmation
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  Review the exact visit before signing.
                </p>
              </div>

              <dl className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4">
                {[
                  ["Client", `Client ${endedVisit.clientCode}`],
                  [
                    "Service",
                    `${endedVisit.serviceCode} · ${endedVisit.serviceName}`,
                  ],
                  ["Date", formatVisitDate(endedVisit.timeIn)],
                  ["Time in", formatClockTime(endedVisit.timeIn)],
                  ["Time out", formatClockTime(endedVisit.timeOut)],
                  [
                    "Total time",
                    `${formatHours(endedVisit.workedMinutes)} hours`,
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-start justify-between gap-4 py-3 text-sm"
                  >
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="text-right font-semibold text-slate-950">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {confirmationMode === "signature" ? (
                <div className="space-y-4">
                  <label className="block text-sm font-semibold text-slate-700">
                    Who is signing?
                    <select
                      aria-label="Who is signing?"
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
                      Sign below to confirm these times
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Firme abajo para confirmar estas horas.
                    </p>
                  </div>
                  <SignaturePad onChange={setSignature} />
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
                    No client or guardian available
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
                    Brief explanation{" "}
                    <span className="font-normal">(optional)</span>
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
                    disabled={!noSignerReason || saving}
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
                  {formatHours(endedVisit.workedMinutes)} hours
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
            <span>No GPS</span>
          </footer>
        </div>
      </Card>
    </div>
  );
}
