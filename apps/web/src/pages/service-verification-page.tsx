import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, PenLine, ShieldCheck } from "lucide-react";
import { useAuth } from "@carelik/auth";
import { Button, Card, StatusBadge, type StatusTone } from "@carelik/ui";
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

interface VerificationOption {
  shift_id: string;
  client_id: string;
  client_code: string;
  caregiver_user_id: string;
  caregiver_name: string;
  service_id: string;
  service_name: string;
  authorization_id: string;
  max_monthly_hours: number;
  starts_at: string;
  ends_at: string;
  signed_minutes_this_month: number;
}

interface ActiveVisit {
  visit_id: string;
  client_code: string;
  service_name: string;
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

const STATUS_TONE: Record<ServiceVisitStatus, StatusTone> = {
  draft: "info",
  awaiting_signature: "warning",
  signed: "success",
  administrator_review: "danger",
  corrected: "neutral",
  voided: "neutral"
};

type Phase = "loading" | "select" | "active" | "review" | "sign" | "success";

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
      <div className="overflow-hidden rounded-xl border-2 border-slate-300 bg-white">
        <canvas
          ref={canvasRef}
          aria-label="Signature pad"
          className="block h-48 w-full touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <button type="button" onClick={clear} className="mt-2 min-h-12 text-sm font-semibold text-slate-600 underline">
        Clear signature
      </button>
    </div>
  );
}

export function ServiceVerificationPage() {
  const { user } = useAuth();
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("loading");
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [notes, setNotes] = useState("");
  const [attested, setAttested] = useState(false);
  const [clientConfirmed, setClientConfirmed] = useState(false);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [endedVisit, setEndedVisit] = useState<{ timeIn: string; timeOut: string; workedMinutes: number } | null>(
    null
  );
  const [signerRole, setSignerRole] = useState<VisitSignerRole>("client");
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [result, setResult] = useState<{
    month_to_date_minutes: number;
    remaining_minutes: number;
    authorization_status: VisitAuthorizationStatus;
  } | null>(null);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["service-verification-options", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["active-service-visit", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["service-visits", activeOrganizationId] });
  }

  const activeVisitQuery = useQuery({
    queryKey: ["active-service-visit", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("get_active_service_visit", {
        target_organization_id: activeOrganizationId!
      });
      if (queryError) throw queryError;
      return ((data ?? [])[0] ?? null) as ActiveVisit | null;
    },
    enabled: !!activeOrganizationId
  });

  const optionsQuery = useQuery({
    queryKey: ["service-verification-options", activeOrganizationId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.rpc("list_service_verification_options", {
        target_organization_id: activeOrganizationId!
      });
      if (queryError) throw queryError;
      return (data ?? []) as VerificationOption[];
    },
    enabled: !!activeOrganizationId && phase === "select"
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

  // Resume an in-progress visit after a reload - the draft lives in the
  // database (time_in already server-set), not in this component's state.
  useEffect(() => {
    if (activeVisitQuery.isLoading) return;
    if (activeVisitQuery.data) {
      setVisitId(activeVisitQuery.data.visit_id);
      setPhase((current) => (current === "loading" || current === "select" ? "active" : current));
    } else if (phase === "loading") {
      setPhase("select");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVisitQuery.data, activeVisitQuery.isLoading]);

  useEffect(() => {
    if (phase !== "active") return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  const selectedOption = useMemo(
    () => (optionsQuery.data ?? []).find((option) => option.shift_id === selectedShiftId),
    [optionsQuery.data, selectedShiftId]
  );

  const active = activeVisitQuery.data;
  const elapsedSeconds = active ? Math.max(0, (nowTick - new Date(active.time_in).getTime()) / 1000) : 0;
  const elapsedMinutes = elapsedSeconds / 60;
  const authorizedMinutes = active ? Math.round(active.max_monthly_hours * 60) : 0;
  const usedMinutes = active?.signed_minutes_this_month ?? 0;
  const projectedMinutes = usedMinutes + elapsedMinutes;
  const remainingMinutes = Math.max(0, authorizedMinutes - usedMinutes);
  const willExceed = active ? projectedMinutes > authorizedMinutes : false;

  async function startVisit() {
    if (!activeOrganizationId || !selectedOption) return;
    setSaving(true);
    setError(null);
    try {
      const { error: startError } = await supabase.rpc("start_service_visit", {
        target_organization_id: activeOrganizationId,
        target_shift_id: selectedOption.shift_id,
        visit_task_categories: [],
        visit_service_notes: notes || null
      });
      if (startError) throw startError;
      setNotes("");
      invalidateAll();
      setPhase("active");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The visit could not be started.");
    } finally {
      setSaving(false);
    }
  }

  async function endVisit() {
    if (!visitId) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: endError } = await supabase.rpc("end_service_visit", {
        target_visit_id: visitId
      });
      if (endError) throw endError;
      const ended = (Array.isArray(data) ? data[0] : data) as {
        time_in: string;
        time_out: string;
        worked_minutes: number;
      };
      setEndedVisit({ timeIn: ended.time_in, timeOut: ended.time_out, workedMinutes: ended.worked_minutes });
      invalidateAll();
      setPhase("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The visit could not be ended.");
    } finally {
      setSaving(false);
    }
  }

  async function cancelActiveVisit() {
    if (!visitId) return;
    const reason = window.prompt("Why is this visit being cancelled? (required)");
    if (!reason || !reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { error: voidError } = await supabase.rpc("void_service_visit", {
        target_visit_id: visitId,
        reason: reason.trim()
      });
      if (voidError) throw voidError;
      reset();
      invalidateAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The visit could not be cancelled.");
    } finally {
      setSaving(false);
    }
  }

  // Lets a caregiver come back later and finish signing a visit they
  // already ended (the client wasn't available yet) without losing the
  // recorded time - selecting it from "Recent visits" jumps straight to
  // the sign step.
  function resumeSigning(visit: VisitRow) {
    setVisitId(visit.id);
    setEndedVisit(
      visit.time_out
        ? { timeIn: visit.time_in, timeOut: visit.time_out, workedMinutes: visit.worked_minutes ?? 0 }
        : null
    );
    setError(null);
    setClientConfirmed(false);
    setSignature(null);
    setPhase("sign");
  }

  async function submitSignature() {
    if (!signature || !clientConfirmed || !visitId || !activeOrganizationId) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(signature);
      const blob = await response.blob();
      const path = `${activeOrganizationId}/${visitId}/client-signature.png`;
      const { error: uploadError } = await supabase.storage
        .from("visit-signatures")
        .upload(path, blob, { contentType: "image/png", upsert: false });
      if (uploadError) throw uploadError;

      const { data, error: signError } = await supabase.rpc("sign_service_visit", {
        target_visit_id: visitId,
        signer_role: signerRole,
        signature_storage_path: path
      });
      if (signError) throw signError;
      const signed = (Array.isArray(data) ? data[0] : data) as {
        month_to_date_minutes: number;
        remaining_minutes: number;
        authorization_status: VisitAuthorizationStatus;
      };
      setResult(signed);
      setPhase("success");
      invalidateAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The signature could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setPhase("select");
    setSelectedShiftId("");
    setNotes("");
    setAttested(false);
    setClientConfirmed(false);
    setVisitId(null);
    setEndedVisit(null);
    setSignature(null);
    setResult(null);
    setError(null);
  }

  if (!user) {
    return <p className="text-sm text-slate-500">Sign in to use Service Verification.</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-24">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wider text-sky-700">Service Verification</p>
        <h1 className="mt-1 text-3xl font-semibold text-slate-950">Confirm a completed visit</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Start the visit when you arrive, end it when you leave, then hand the phone to the client to sign.
        </p>
      </header>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          {error}
        </div>
      ) : null}

      {phase === "loading" ? <p className="text-sm text-slate-500">Loading…</p> : null}

      {phase === "select" ? (
        <Card className="space-y-5">
          <div className="flex items-center gap-3">
            <Clock3 className="h-5 w-5 text-sky-700" />
            <h2 className="text-xl font-semibold">Start a visit</h2>
          </div>
          <label className="block text-sm font-medium text-slate-700">
            Assigned shift
            <select
              value={selectedShiftId}
              onChange={(event) => setSelectedShiftId(event.target.value)}
              className="mt-2 min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
            >
              <option value="">Select a shift</option>
              {(optionsQuery.data ?? []).map((option) => (
                <option key={option.shift_id} value={option.shift_id}>
                  {option.client_code} · {option.service_name} · {formatVisitDate(option.starts_at)}
                </option>
              ))}
            </select>
          </label>
          {optionsQuery.isSuccess && (optionsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">No assigned shifts are available to verify right now.</p>
          ) : null}
          {selectedOption ? (
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="font-semibold">{selectedOption.client_code}</p>
              <p className="text-sm text-slate-600">{selectedOption.service_name}</p>
              <p className="mt-2 text-xs text-slate-500">
                Used this month: {formatHours(selectedOption.signed_minutes_this_month)} of{" "}
                {formatHours(Math.round(selectedOption.max_monthly_hours * 60))} authorized hours
              </p>
            </div>
          ) : null}
          <label className="block text-sm font-medium text-slate-700">
            Short service note (optional)
            <textarea
              value={notes}
              maxLength={500}
              onChange={(event) => setNotes(event.target.value)}
              className="mt-2 min-h-24 w-full rounded-lg border border-slate-300 p-3 text-base"
            />
          </label>
          <Button
            type="button"
            className="min-h-12 w-full sm:w-auto"
            disabled={!selectedOption}
            loading={saving}
            onClick={startVisit}
          >
            Time in: start visit
          </Button>
        </Card>
      ) : null}

      {phase === "active" && active ? (
        <div className="space-y-5">
          <Card className="space-y-5">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-sky-700" />
              <h2 className="text-xl font-semibold">Visit in progress</h2>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="font-semibold">{active.client_code}</p>
              <p className="text-sm text-slate-600">{active.service_name}</p>
              <p className="mt-1 text-xs text-slate-500">Started at {formatClockTime(active.time_in)} Pacific</p>
            </div>
            <div className="text-center">
              <p className="text-sm text-slate-500">Elapsed time</p>
              <p className="mt-1 font-mono text-5xl font-semibold text-slate-950">
                {formatElapsed(elapsedSeconds)}
              </p>
            </div>
            {willExceed ? (
              <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>
                  <strong>This visit will exceed the remaining authorized hours.</strong> Worked time will still be
                  recorded in full - the excess will go to administrator review for billing.
                </p>
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-center text-sm text-slate-600">
                {formatHours(remainingMinutes)} authorized hours remaining this month
              </p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button type="button" className="min-h-14 flex-1 text-base" loading={saving} onClick={endVisit}>
                Time out: end visit
              </Button>
              <Button type="button" variant="ghost" className="min-h-12" onClick={cancelActiveVisit}>
                Cancel visit
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {phase === "review" && endedVisit ? (
        <Card className="space-y-5">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-sky-700" />
            <h2 className="text-xl font-semibold">Caregiver review</h2>
          </div>
          <div className="grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2">
            <p>
              <span className="block text-sm text-slate-500">Time</span>
              <strong>
                {formatClockTime(endedVisit.timeIn)}–{formatClockTime(endedVisit.timeOut)}
              </strong>
            </p>
            <p>
              <span className="block text-sm text-slate-500">Total</span>
              <strong>{formatHours(endedVisit.workedMinutes)} hours</strong>
            </p>
          </div>
          <label className="flex min-h-12 items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm font-medium">
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
              className="mt-0.5 h-5 w-5"
            />
            I confirm that the visit information above is complete and accurate.
          </label>
          <Button
            type="button"
            className="min-h-12 w-full"
            disabled={!attested}
            onClick={() => setPhase("sign")}
          >
            Continue to client sign-off
          </Button>
        </Card>
      ) : null}

      {phase === "sign" && endedVisit ? (
        <Card className="mx-auto max-w-xl space-y-6 p-4 sm:p-6">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wider text-sky-700">
              {activeOrganization?.displayName ?? "CareLik"}
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Confirm today&rsquo;s visit</h2>
          </div>
          <div className="space-y-3 rounded-xl bg-slate-50 p-4 text-base">
            <div className="flex justify-between gap-4">
              <span className="text-slate-500">Time</span>
              <strong>
                {formatClockTime(endedVisit.timeIn)}–{formatClockTime(endedVisit.timeOut)}
              </strong>
            </div>
            <div className="flex justify-between gap-4 border-t border-slate-200 pt-3">
              <span>Today&rsquo;s hours</span>
              <strong className="text-xl">{formatHours(endedVisit.workedMinutes)}</strong>
            </div>
          </div>
          <p className="text-center text-base font-medium">
            I confirm that the services and hours shown above were provided on the date stated.
          </p>
          <label className="block text-sm font-medium">
            I am signing as
            <select
              value={signerRole}
              onChange={(event) => setSignerRole(event.target.value as VisitSignerRole)}
              className="mt-2 min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
            >
              <option value="client">Client</option>
              <option value="parent">Parent</option>
              <option value="guardian">Guardian</option>
              <option value="authorized_representative">Authorized representative</option>
            </select>
          </label>
          <div>
            <p className="mb-2 text-sm font-medium">Signature</p>
            <SignaturePad onChange={setSignature} />
          </div>
          <label className="flex min-h-12 items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm font-medium">
            <input
              type="checkbox"
              checked={clientConfirmed}
              onChange={(event) => setClientConfirmed(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            I reviewed the visit information and confirm that it is correct.
          </label>
          <Button
            className="min-h-14 w-full text-base"
            disabled={!signature || !clientConfirmed}
            loading={saving}
            icon={<PenLine className="h-5 w-5" />}
            onClick={submitSignature}
          >
            Confirm and sign
          </Button>
        </Card>
      ) : null}

      {phase === "success" && result ? (
        <Card className="mx-auto max-w-xl space-y-6 text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" />
          <div>
            <h2 className="text-2xl font-semibold">Visit signed successfully</h2>
            <p className="mt-2 text-slate-600">The record is locked and ready for review.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4">
            <div>
              <p className="text-sm text-slate-500">Month to date</p>
              <p className="text-xl font-semibold">{formatHours(result.month_to_date_minutes)} hrs</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Remaining</p>
              <p className="text-xl font-semibold text-emerald-700">{formatHours(result.remaining_minutes)} hrs</p>
            </div>
          </div>
          <StatusBadge
            label={result.authorization_status.replaceAll("_", " ")}
            tone={result.authorization_status === "exceeds_authorization" ? "danger" : "success"}
          />
          {result.authorization_status === "exceeds_authorization" ? (
            <p className="text-sm text-amber-800">
              This visit exceeded the monthly authorization. All worked time was recorded; an administrator will
              review the billable portion.
            </p>
          ) : null}
          <Button className="min-h-12 w-full" onClick={reset}>
            Record another visit
          </Button>
        </Card>
      ) : null}

      {(visitsQuery.data?.length ?? 0) > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold">Recent visits</h2>
            <p className="text-sm text-slate-500">
              {hasPermission("visits.read") ? "Organization records" : "Your submitted records"}
            </p>
          </div>
          <div className="grid gap-3">
            {visitsQuery.data!.slice(0, 10).map((visit) => (
              <Card
                key={visit.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-semibold">
                    {visit.client_code} · {visit.service_name}
                  </p>
                  <p className="text-sm text-slate-500">
                    {formatVisitDate(`${visit.service_date}T12:00:00-07:00`)} · {visit.caregiver_name} ·{" "}
                    {visit.worked_minutes ? `${formatHours(visit.worked_minutes)} hrs` : "in progress"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {visit.is_corrected ? <StatusBadge label="Corrected" tone="neutral" /> : null}
                  <StatusBadge label={VISIT_STATUS_LABEL[visit.status]} tone={STATUS_TONE[visit.status]} />
                  {visit.status === "awaiting_signature" && visit.caregiver_name && phase !== "sign" ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => resumeSigning(visit)}>
                      Finish signing
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
