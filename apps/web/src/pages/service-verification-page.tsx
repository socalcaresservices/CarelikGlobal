import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Accessibility,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Keyboard,
  LockKeyhole,
  Mic,
  PenLine,
  ShieldCheck
} from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Button, Card, StatusBadge, cn, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import {
  formatClockTime,
  formatElapsed,
  formatHours,
  formatVisitDate,
  VISIT_STATUS_LABEL,
  type ServiceVisitStatus,
  type VisitAuthorizationStatus,
  type VisitSignerRole
} from "@/lib/service-verification";

interface FoundClient {
  client_id: string;
  client_code: string;
}

interface StartableShift {
  shift_id: string;
  visit_number: string;
  client_id: string;
  client_code: string;
  client_name: string;
  service_id: string;
  service_code: string;
  service_name: string;
  service_color: string | null;
  authorization_id: string;
  max_monthly_hours: number;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
  starts_at: string;
  ends_at: string;
}

interface ActiveVisit {
  visit_id: string;
  visit_number: string | null;
  client_code: string;
  client_name: string;
  service_code: string;
  service_name: string;
  scheduled_starts_at: string | null;
  scheduled_ends_at: string | null;
  time_in: string;
  max_monthly_hours: number;
  signed_minutes_this_month: number;
}

interface VisitRow {
  id: string;
  client_code: string;
  caregiver_name: string;
  service_name: string;
  service_date: string;
  time_in: string;
  time_out: string | null;
  worked_minutes: number | null;
  billable_minutes: number | null;
  status: ServiceVisitStatus;
  authorization_status: VisitAuthorizationStatus | null;
  is_corrected: boolean;
}

interface EndedVisit {
  timeIn: string;
  timeOut: string;
  workedMinutes: number;
  clientCode: string;
  clientName: string;
  serviceCode: string;
  serviceName: string;
  visitNumber: string | null;
}

type ConfirmationMethod = "draw" | "typed" | "verbal" | "assisted_mark" | "unable_to_confirm";
type Phase = "loading" | "start" | "active" | "confirm" | "success";

const STATUS_TONE: Record<ServiceVisitStatus, StatusTone> = {
  draft: "info",
  awaiting_signature: "warning",
  signed: "success",
  administrator_review: "danger",
  corrected: "neutral",
  voided: "neutral"
};

const CONFIRMATION_OPTIONS: Array<{
  value: ConfirmationMethod;
  label: string;
  description: string;
  icon: typeof PenLine;
}> = [
  { value: "draw", label: "Draw signature", description: "Sign with a finger or stylus", icon: PenLine },
  { value: "typed", label: "Type name", description: "Type the confirming person's name", icon: Keyboard },
  { value: "verbal", label: "Verbal confirmation", description: "Record who confirmed verbally", icon: Mic },
  { value: "assisted_mark", label: "Assisted mark", description: "Capture a mark when a full signature is difficult", icon: Accessibility },
  {
    value: "unable_to_confirm",
    label: "Unable to confirm",
    description: "Send the visit to administrator review with a reason",
    icon: AlertTriangle
  }
];

function formatServiceHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function availableServiceHours(shift: StartableShift) {
  return Math.max(0, shift.max_monthly_hours - shift.hours_used_this_month - shift.hours_scheduled_this_month);
}

function normalizeError(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : fallback;
  return message
    .replace(/^NO_SCHEDULED_VISIT:\s*/i, "")
    .replace(/^MULTIPLE_SCHEDULED_VISITS:\s*/i, "")
    .replace(/^NOT_FOUND:\s*/i, "")
    .replace(/^RATE_LIMITED:\s*/i, "");
}

function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.floor(bounds.width * ratio);
      canvas.height = Math.floor(bounds.height * ratio);
      const context = canvas.getContext("2d");
      context?.scale(ratio, ratio);
      if (context) {
        context.lineWidth = 2.5;
        context.lineCap = "round";
        context.strokeStyle = "#0f172a";
      }
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
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
      <div className="overflow-hidden rounded-2xl border-2 border-slate-300 bg-white">
        <canvas
          ref={canvasRef}
          aria-label="Signature pad"
          className="block h-44 w-full touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <button type="button" onClick={clear} className="mt-2 min-h-11 text-sm font-semibold text-slate-600 underline">
        Clear
      </button>
    </div>
  );
}

function StepHeader({ step, title, subtitle }: { step: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent,#4f46e5)] text-sm font-bold text-white">
        {step}
      </span>
      <div>
        <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>
      </div>
    </div>
  );
}

export function ServiceVerificationPage() {
  const { user } = useAuth();
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("loading");
  const [clientCodeInput, setClientCodeInput] = useState("");
  const [lookupClient, setLookupClient] = useState<FoundClient | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [notes, setNotes] = useState("");
  const [visitId, setVisitId] = useState<string | null>(null);
  const [endedVisit, setEndedVisit] = useState<EndedVisit | null>(null);
  const [signerRole, setSignerRole] = useState<VisitSignerRole>("client");
  const [confirmationMethod, setConfirmationMethod] = useState<ConfirmationMethod>("draw");
  const [signature, setSignature] = useState<string | null>(null);
  const [typedSignerName, setTypedSignerName] = useState("");
  const [signerRelationship, setSignerRelationship] = useState("");
  const [confirmationReason, setConfirmationReason] = useState("");
  const [caregiverAttested, setCaregiverAttested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [result, setResult] = useState<{
    status: ServiceVisitStatus;
    month_to_date_minutes: number;
    remaining_minutes: number;
    authorization_status: VisitAuthorizationStatus;
  } | null>(null);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["active-service-visit-v2", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["service-visits", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["startable-shifts", activeOrganizationId] });
  }

  const activeVisitQuery = useQuery({
    queryKey: ["active-service-visit-v2", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("get_active_service_visit_v2", {
        target_organization_id: activeOrganizationId!
      });
      if (queryError) throw queryError;
      return ((data ?? [])[0] ?? null) as ActiveVisit | null;
    },
    enabled: !!activeOrganizationId
  });

  const shiftsQuery = useQuery({
    queryKey: ["startable-shifts", activeOrganizationId, lookupClient?.client_id],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("list_startable_shifts_for_client", {
        target_organization_id: activeOrganizationId!,
        target_client_id: lookupClient!.client_id
      });
      if (queryError) throw queryError;
      return (data ?? []) as StartableShift[];
    },
    enabled: !!activeOrganizationId && !!lookupClient && phase === "start"
  });

  const visitsQuery = useQuery({
    queryKey: ["service-visits", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("list_service_visits", {
        target_organization_id: activeOrganizationId!
      });
      if (queryError) throw queryError;
      return (data ?? []) as VisitRow[];
    },
    enabled: !!activeOrganizationId
  });

  useEffect(() => {
    if (activeVisitQuery.isLoading) return;
    if (activeVisitQuery.data) {
      setVisitId(activeVisitQuery.data.visit_id);
      setPhase((current) => (current === "loading" || current === "start" ? "active" : current));
    } else if (phase === "loading") {
      setPhase("start");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVisitQuery.data, activeVisitQuery.isLoading]);

  useEffect(() => {
    if (phase !== "active") return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if ((shiftsQuery.data ?? []).length === 1 && !selectedShiftId) {
      setSelectedShiftId(shiftsQuery.data![0]!.shift_id);
    }
  }, [selectedShiftId, shiftsQuery.data]);

  const selectedShift = useMemo(
    () => (shiftsQuery.data ?? []).find((shift) => shift.shift_id === selectedShiftId),
    [selectedShiftId, shiftsQuery.data]
  );

  const active = activeVisitQuery.data;
  const elapsedSeconds = active ? Math.max(0, (nowTick - new Date(active.time_in).getTime()) / 1000) : 0;
  const elapsedMinutes = elapsedSeconds / 60;
  const authorizedMinutes = active ? Math.round(active.max_monthly_hours * 60) : 0;
  const usedMinutes = active?.signed_minutes_this_month ?? 0;
  const projectedMinutes = usedMinutes + elapsedMinutes;
  const remainingMinutes = Math.max(0, authorizedMinutes - usedMinutes);
  const willExceed = active ? projectedMinutes > authorizedMinutes : false;

  async function lookupClientByCode() {
    if (!activeOrganizationId || !clientCodeInput.trim()) return;
    setLookingUp(true);
    setError(null);
    try {
      const { data, error: lookupError } = await supabase.rpc("find_client_by_code", {
        target_organization_id: activeOrganizationId,
        target_client_code: clientCodeInput.trim()
      });
      if (lookupError) throw lookupError;
      const found = (Array.isArray(data) ? data[0] : data) as FoundClient | undefined;
      if (!found) throw new Error("That client ID was not found or is not active.");
      setLookupClient(found);
      setSelectedShiftId("");
    } catch (cause) {
      setError(normalizeError(cause, "That client ID could not be looked up."));
    } finally {
      setLookingUp(false);
    }
  }

  function changeClient() {
    setLookupClient(null);
    setClientCodeInput("");
    setSelectedShiftId("");
    setError(null);
  }

  async function startVisit() {
    if (!activeOrganizationId || !selectedShift) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: startError } = await supabase.rpc("start_service_visit", {
        target_organization_id: activeOrganizationId,
        target_shift_id: selectedShift.shift_id,
        visit_task_categories: [],
        visit_service_notes: null
      });
      if (startError) throw startError;
      if (typeof data === "string") setVisitId(data);
      invalidateAll();
      await activeVisitQuery.refetch();
      setPhase("active");
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be started."));
    } finally {
      setSaving(false);
    }
  }

  async function endVisit() {
    if (!visitId || !active) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: endError } = await supabase.rpc("end_service_visit", {
        target_visit_id: visitId,
        visit_task_categories: [],
        visit_service_notes: notes.trim() || null
      });
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
        clientName: active.client_name,
        serviceCode: active.service_code,
        serviceName: active.service_name,
        visitNumber: active.visit_number
      });
      invalidateAll();
      setPhase("confirm");
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be ended."));
    } finally {
      setSaving(false);
    }
  }

  function confirmationIsComplete() {
    if (!caregiverAttested) return false;
    if (confirmationMethod === "draw" || confirmationMethod === "assisted_mark") return !!signature;
    if (confirmationMethod === "typed" || confirmationMethod === "verbal") return !!typedSignerName.trim();
    if (confirmationMethod === "unable_to_confirm") return !!confirmationReason.trim();
    return false;
  }

  async function submitConfirmation() {
    if (!visitId || !activeOrganizationId || !confirmationIsComplete()) return;
    setSaving(true);
    setError(null);

    try {
      let storagePath: string | null = null;
      if (confirmationMethod === "draw" || confirmationMethod === "assisted_mark") {
        if (!signature) return;
        const response = await fetch(signature);
        const blob = await response.blob();
        storagePath = `${activeOrganizationId}/${visitId}/client-signature.png`;
        const { error: uploadError } = await supabase.storage
          .from("visit-signatures")
          .upload(storagePath, blob, { contentType: "image/png", upsert: false });
        if (uploadError) throw uploadError;
      }

      const { data, error: confirmError } = await supabase.rpc("confirm_service_visit", {
        target_visit_id: visitId,
        signer_role: signerRole,
        confirmation_method: confirmationMethod,
        signature_storage_path: storagePath,
        typed_signer_name: typedSignerName.trim() || null,
        signer_relationship: signerRelationship.trim() || null,
        confirmation_reason: confirmationReason.trim() || null
      });
      if (confirmError) throw confirmError;

      const confirmed = (Array.isArray(data) ? data[0] : data) as {
        status: ServiceVisitStatus;
        month_to_date_minutes: number;
        remaining_minutes: number;
        authorization_status: VisitAuthorizationStatus;
      };
      setResult(confirmed);
      setPhase("success");
      invalidateAll();
    } catch (cause) {
      setError(normalizeError(cause, "The visit could not be submitted."));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setPhase("start");
    setClientCodeInput("");
    setLookupClient(null);
    setSelectedShiftId("");
    setNotes("");
    setVisitId(null);
    setEndedVisit(null);
    setSignerRole("client");
    setConfirmationMethod("draw");
    setSignature(null);
    setTypedSignerName("");
    setSignerRelationship("");
    setConfirmationReason("");
    setCaregiverAttested(false);
    setResult(null);
    setError(null);
  }

  function resumeConfirmation(visit: VisitRow) {
    if (!visit.time_out) return;
    setVisitId(visit.id);
    setEndedVisit({
      timeIn: visit.time_in,
      timeOut: visit.time_out,
      workedMinutes: visit.worked_minutes ?? 0,
      clientCode: visit.client_code,
      clientName: visit.client_code,
      serviceCode: "",
      serviceName: visit.service_name,
      visitNumber: null
    });
    setSignature(null);
    setTypedSignerName("");
    setConfirmationReason("");
    setCaregiverAttested(false);
    setError(null);
    setPhase("confirm");
  }

  if (!user) {
    return <p className="text-sm text-slate-500">Sign in to use Service Verification.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-24">
      <header className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--color-accent,#4f46e5)]">
          Shift Verification
        </p>
        <h1 className="text-3xl font-semibold text-slate-950">Verify your visit</h1>
        <p className="max-w-2xl text-slate-600">
          Four simple steps. Time in and time out are recorded automatically and can only be corrected by an administrator.
        </p>
      </header>

      <div className="grid grid-cols-4 gap-2" aria-label="Visit progress">
        {["Start", "Active", "Confirm", "Submitted"].map((label, index) => {
          const phaseOrder: Phase[] = ["start", "active", "confirm", "success"];
          const currentIndex = phaseOrder.indexOf(phase === "loading" ? "start" : phase);
          const done = index < currentIndex;
          const current = index === currentIndex;
          return (
            <div key={label} className="text-center">
              <div
                className={cn(
                  "mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                  done || current
                    ? "bg-[var(--color-accent,#4f46e5)] text-white"
                    : "bg-slate-200 text-slate-500"
                )}
              >
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              <p className="mt-1 hidden text-xs font-medium text-slate-500 sm:block">{label}</p>
            </div>
          );
        })}
      </div>

      {error ? (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          {error}
        </div>
      ) : null}

      {phase === "loading" ? <p className="text-sm text-slate-500">Loading…</p> : null}

      {phase === "start" ? (
        <Card className="space-y-6 rounded-2xl p-4 sm:p-6">
          <StepHeader step={1} title="Start visit" subtitle="Enter the client code and confirm the scheduled service." />

          {!lookupClient ? (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Client code
                <input
                  type="text"
                  value={clientCodeInput}
                  onChange={(event) => setClientCodeInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void lookupClientByCode();
                    }
                  }}
                  placeholder="Enter or scan client code"
                  autoCapitalize="characters"
                  className="mt-2 min-h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-base"
                />
              </label>
              <Button
                type="button"
                className="min-h-14 w-full text-base"
                disabled={!clientCodeInput.trim()}
                loading={lookingUp}
                onClick={lookupClientByCode}
              >
                Verify client
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between rounded-2xl bg-slate-50 p-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Verified client</p>
                  <p className="mt-1 font-semibold text-slate-950">{lookupClient.client_code}</p>
                </div>
                <button type="button" onClick={changeClient} className="min-h-11 text-sm font-semibold text-slate-600 underline">
                  Change
                </button>
              </div>

              {shiftsQuery.isLoading ? <p className="text-sm text-slate-500">Loading today&apos;s scheduled visit…</p> : null}
              {shiftsQuery.isError ? (
                <p className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">
                  Today&apos;s scheduled visit could not be loaded. Contact your agency administrator.
                </p>
              ) : null}
              {shiftsQuery.isSuccess && (shiftsQuery.data ?? []).length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-semibold">No scheduled visit is available for this client today.</p>
                  <p className="mt-1">Extra visits must be added by an agency administrator before you can start them.</p>
                </div>
              ) : null}

              {(shiftsQuery.data ?? []).length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-slate-700">Scheduled service</p>
                  {shiftsQuery.data!.map((shift) => {
                    const selected = shift.shift_id === selectedShiftId;
                    const available = availableServiceHours(shift);
                    return (
                      <button
                        key={shift.shift_id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedShiftId(shift.shift_id)}
                        className={cn(
                          "flex w-full gap-3 rounded-2xl border-2 p-4 text-left transition",
                          selected
                            ? "border-[var(--color-accent,#4f46e5)] bg-violet-50/50"
                            : "border-slate-200 bg-white hover:border-slate-300"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2",
                            selected
                              ? "border-[var(--color-accent,#4f46e5)] bg-[var(--color-accent,#4f46e5)] text-white"
                              : "border-slate-300 text-transparent"
                          )}
                        >
                          <Check className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-slate-950">{shift.client_name}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700">
                              {shift.service_code}
                            </span>
                            <span className="text-sm font-semibold text-[var(--color-accent,#4f46e5)]">
                              {shift.service_name}
                            </span>
                          </span>
                          <span className="mt-2 block text-xs text-slate-500">
                            Scheduled {formatClockTime(shift.starts_at)}–{formatClockTime(shift.ends_at)} · {formatServiceHours(available)}h available after scheduled commitments
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {selectedShift ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                      <Clock3 className="h-4 w-4" /> Time in
                    </div>
                    <p className="mt-1 text-2xl font-semibold text-slate-950">Now</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Ogevia records the server time automatically. Caregivers cannot backdate or edit it.
                    </p>
                  </div>
                  <Button type="button" className="min-h-14 w-full text-base" loading={saving} onClick={startVisit}>
                    Start visit now
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}

      {phase === "active" && active ? (
        <Card className="space-y-6 rounded-2xl p-4 sm:p-6">
          <StepHeader step={2} title="Visit in progress" subtitle="Your time is being recorded automatically." />

          <div className="text-center">
            <div className="mx-auto mb-3 flex w-fit items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Live
            </div>
            <p className="font-mono text-5xl font-semibold tracking-tight text-slate-950 sm:text-6xl">
              {formatElapsed(elapsedSeconds)}
            </p>
            <p className="mt-2 text-sm text-slate-500">Elapsed time</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Client</p>
              <p className="mt-1 font-semibold text-slate-950">{active.client_name}</p>
              <p className="text-xs text-slate-500">{active.client_code}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Service</p>
              <p className="mt-1 font-semibold text-slate-950">
                {active.service_code} · {active.service_name}
              </p>
              <p className="text-xs text-slate-500">Time in {formatClockTime(active.time_in)}</p>
            </div>
          </div>

          {active.scheduled_starts_at && active.scheduled_ends_at ? (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-center text-sm text-slate-600">
              Scheduled {formatClockTime(active.scheduled_starts_at)}–{formatClockTime(active.scheduled_ends_at)}
            </p>
          ) : null}

          {willExceed ? (
            <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <p>
                <strong>This visit is projected to exceed the remaining authorization.</strong> Worked time will still be recorded in full and sent for administrator review.
              </p>
            </div>
          ) : (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-center text-sm text-slate-600">
              {formatHours(remainingMinutes)} authorized hours remaining this month
            </p>
          )}

          <label className="block text-sm font-medium text-slate-700">
            Visit note <span className="font-normal text-slate-400">(optional)</span>
            <textarea
              value={notes}
              maxLength={1000}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add a short service note…"
              className="mt-2 min-h-24 w-full rounded-xl border border-slate-300 bg-white p-3 text-base"
            />
          </label>

          <div className="space-y-2">
            <Button type="button" className="min-h-14 w-full text-base" loading={saving} onClick={endVisit}>
              End visit now
            </Button>
            <p className="text-center text-xs text-slate-500">
              Time Out is recorded as Now. Need a correction? Contact your administrator after submitting.
            </p>
          </div>
        </Card>
      ) : null}

      {phase === "confirm" && endedVisit ? (
        <Card className="space-y-6 rounded-2xl p-4 sm:p-6">
          <StepHeader step={3} title="Confirm visit" subtitle="Review the visit once, choose a confirmation method, and submit." />

          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-slate-500">Client</p>
                <p className="font-semibold text-slate-950">{endedVisit.clientName}</p>
              </div>
              <div>
                <p className="text-slate-500">Service</p>
                <p className="font-semibold text-slate-950">
                  {endedVisit.serviceCode ? `${endedVisit.serviceCode} · ` : ""}{endedVisit.serviceName}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Time</p>
                <p className="font-semibold text-slate-950">
                  {formatClockTime(endedVisit.timeIn)}–{formatClockTime(endedVisit.timeOut)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Total</p>
                <p className="text-xl font-semibold text-emerald-700">{formatHours(endedVisit.workedMinutes)} hours</p>
              </div>
            </div>
          </div>

          <label className="block text-sm font-medium text-slate-700">
            Who is confirming?
            <select
              value={signerRole}
              onChange={(event) => setSignerRole(event.target.value as VisitSignerRole)}
              className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
            >
              <option value="client">Client</option>
              <option value="parent">Parent</option>
              <option value="guardian">Guardian</option>
              <option value="authorized_representative">Authorized representative</option>
            </select>
          </label>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-700">How will the visit be confirmed?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {CONFIRMATION_OPTIONS.map((option) => {
                const selected = confirmationMethod === option.value;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setConfirmationMethod(option.value);
                      setSignature(null);
                    }}
                    className={cn(
                      "flex min-h-20 items-start gap-3 rounded-2xl border-2 p-3 text-left",
                      selected
                        ? "border-[var(--color-accent,#4f46e5)] bg-violet-50/50"
                        : "border-slate-200 bg-white"
                    )}
                  >
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent,#4f46e5)]" />
                    <span>
                      <span className="block text-sm font-semibold text-slate-950">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{option.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {confirmationMethod === "draw" || confirmationMethod === "assisted_mark" ? (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">
                {confirmationMethod === "assisted_mark" ? "Client / representative mark" : "Client / representative signature"}
              </p>
              <SignaturePad onChange={setSignature} />
            </div>
          ) : null}

          {confirmationMethod === "typed" || confirmationMethod === "verbal" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-slate-700">
                Name of person confirming
                <input
                  type="text"
                  value={typedSignerName}
                  onChange={(event) => setTypedSignerName(event.target.value)}
                  className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
                  placeholder="Full name"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Relationship <span className="font-normal text-slate-400">(optional)</span>
                <input
                  type="text"
                  value={signerRelationship}
                  onChange={(event) => setSignerRelationship(event.target.value)}
                  className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
                  placeholder="Client, parent, guardian…"
                />
              </label>
            </div>
          ) : null}

          {confirmationMethod === "unable_to_confirm" ? (
            <label className="block text-sm font-medium text-slate-700">
              Why could confirmation not be obtained?
              <textarea
                value={confirmationReason}
                onChange={(event) => setConfirmationReason(event.target.value)}
                className="mt-2 min-h-24 w-full rounded-xl border border-amber-300 bg-amber-50/40 p-3 text-base"
                placeholder="Reason required. This visit will be sent to administrator review."
              />
            </label>
          ) : null}

          <label className="flex min-h-14 items-start gap-3 rounded-2xl border border-slate-200 p-4 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              checked={caregiverAttested}
              onChange={(event) => setCaregiverAttested(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            I confirm that I provided the service recorded above and that the visit information is accurate to the best of my knowledge.
          </label>

          <Button
            type="button"
            className="min-h-14 w-full text-base"
            disabled={!confirmationIsComplete()}
            loading={saving}
            icon={<LockKeyhole className="h-5 w-5" />}
            onClick={submitConfirmation}
          >
            Confirm & submit visit
          </Button>
          <p className="text-center text-xs text-slate-500">
            After submission the visit is locked. Only an administrator can create an audited correction.
          </p>
        </Card>
      ) : null}

      {phase === "success" && result ? (
        <Card className="mx-auto max-w-xl space-y-6 rounded-2xl p-6 text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" />
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-[var(--color-accent,#4f46e5)]">Step 4</p>
            <h2 className="mt-1 text-2xl font-semibold text-slate-950">Visit submitted</h2>
            <p className="mt-2 text-slate-600">The visit is locked and the original timestamps are preserved.</p>
          </div>

          {endedVisit ? (
            <div className="rounded-2xl bg-slate-50 p-4 text-left text-sm">
              <div className="flex justify-between gap-3 py-1">
                <span className="text-slate-500">Client</span>
                <strong>{endedVisit.clientName}</strong>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-slate-500">Service</span>
                <strong>{endedVisit.serviceCode ? `${endedVisit.serviceCode} · ` : ""}{endedVisit.serviceName}</strong>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <span className="text-slate-500">Time</span>
                <strong>{formatClockTime(endedVisit.timeIn)}–{formatClockTime(endedVisit.timeOut)}</strong>
              </div>
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-2 mt-2">
                <span className="text-slate-500">Total</span>
                <strong>{formatHours(endedVisit.workedMinutes)} hrs</strong>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4">
            <div>
              <p className="text-xs text-slate-500">Month to date</p>
              <p className="text-lg font-semibold">{formatHours(result.month_to_date_minutes)} hrs</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Remaining</p>
              <p className="text-lg font-semibold text-emerald-700">{formatHours(result.remaining_minutes)} hrs</p>
            </div>
          </div>

          <StatusBadge
            label={result.status === "administrator_review" ? "Pending review" : "Submitted"}
            tone={result.status === "administrator_review" ? "warning" : "success"}
          />

          <Button className="min-h-12 w-full" onClick={reset}>
            Done
          </Button>
        </Card>
      ) : null}

      {(visitsQuery.data?.length ?? 0) > 0 && phase !== "active" ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">My recent visits</h2>
            <p className="text-sm text-slate-500">
              {hasPermission("visits.read") ? "Organization records" : "Your submitted records"}
            </p>
          </div>
          <div className="grid gap-3">
            {visitsQuery.data!.slice(0, 10).map((visit) => (
              <Card key={visit.id} className="flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-950">{visit.client_code} · {visit.service_name}</p>
                  <p className="text-sm text-slate-500">
                    {formatVisitDate(`${visit.service_date}T12:00:00-07:00`)} · {visit.caregiver_name} · {visit.worked_minutes ? `${formatHours(visit.worked_minutes)} hrs` : "in progress"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {visit.is_corrected ? <StatusBadge label="Corrected" tone="neutral" /> : null}
                  <StatusBadge label={VISIT_STATUS_LABEL[visit.status]} tone={STATUS_TONE[visit.status]} />
                  {visit.status === "awaiting_signature" && phase !== "confirm" ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => resumeConfirmation(visit)}>
                      Finish confirmation
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex items-center justify-center gap-2 text-center text-xs text-slate-400">
        <ShieldCheck className="h-4 w-4" />
        {activeOrganization?.displayName ?? "Ogevia"} · server-timed · audit protected
      </div>
    </div>
  );
}
