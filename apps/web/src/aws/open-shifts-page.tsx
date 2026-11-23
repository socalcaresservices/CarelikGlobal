import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { Hint } from "./hint";
import { linkClass } from "./ui-classes";
import { OUTCOME_LABEL, useOpenShiftBoard, useWindowLabel, type MyOpenShiftRequest, type OpeningLanding } from "./open-shifts-model";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Entry shown on the caregiver's pages: how many openings they can request right now. */
export function OpenShiftsEntry() {
  const board = useOpenShiftBoard();
  const count = board.data ? Number(board.data[0]?.totalCount ?? board.data.length) : null;
  return (
    <section aria-labelledby="open-shifts-entry" data-testid="open-shifts-entry" className="rounded-lg border border-sky-200 bg-sky-50 p-3">
      <h2 id="open-shifts-entry" className="text-base font-semibold text-slate-950">Open shifts</h2>
      {board.isError ? <p role="alert" className="text-sm text-red-700">Open shifts could not be loaded. Refresh the page.</p> : null}
      {board.isLoading ? <p className="text-sm text-slate-600">Loading…</p> : null}
      {count !== null ? (
        <p className="text-sm text-slate-800">
          <span data-testid="open-shifts-count" className="font-semibold">{count}</span> {count === 1 ? "shift" : "shifts"} you can request.{" "}
          <Link to="/open-shifts" className={linkClass}>{count > 0 ? "See open shifts" : "Open shifts page"}</Link>
        </p>
      ) : null}
    </section>
  );
}

function ConsentCard() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ error: string | null; done: string | null }>({ error: null, done: null });
  const consent = useQuery({
    queryKey: ["aws-sms-consent", activeOrganizationId],
    queryFn: async () => (await api.get<{ consent: { status: "opted_in" | "opted_out"; phoneMasked: string } | null }>("/v1/my-sms-consent", { organizationId: activeOrganizationId })).consent,
    enabled: !!activeOrganizationId,
  });
  const agency = (activeOrganization as { name?: string } | null)?.name ?? "your agency";
  async function save(optIn: boolean) {
    if (busy) return;
    setBusy(true);
    setState({ error: null, done: null });
    try {
      await api.post("/v1/my-sms-consent", { organizationId: activeOrganizationId, phone: phone || "0000000000", optIn });
      setState({ error: null, done: optIn ? "Texts are on." : "Texts are off. You will still see open shifts here." });
      await queryClient.invalidateQueries({ queryKey: ["aws-sms-consent"] });
    } catch (cause) {
      setState({ error: message(cause, "Not saved. Try again."), done: null });
    } finally {
      setBusy(false);
    }
  }
  const on = consent.data?.status === "opted_in";
  return (
    <section aria-labelledby="sms-heading" className="space-y-2 rounded-lg border border-slate-200 bg-og-card p-3 text-sm">
      <h2 id="sms-heading" className="text-base font-semibold text-slate-950">Text messages</h2>
      {on ? <p>Texts are on for {agency} ({consent.data?.phoneMasked}).</p> : <p>Get a text when {agency} has an open shift in a city you cover. Message and data rates may apply. Reply STOP at any time to opt out. Texts never include client names.</p>}
      {!on ? (
        <label className="block text-xs font-medium text-slate-600">Mobile number
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" maxLength={25} className="mt-1 block w-56 max-w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
        </label>
      ) : null}
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-emerald-800">{state.done}</p> : null}
      <Button type="button" className="min-h-11" variant={on ? "secondary" : "primary"} disabled={busy || (!on && phone.trim().length < 7)} loading={busy} onClick={() => void save(!on)}>{on ? "Turn texts off" : "Text me open shifts"}</Button>
    </section>
  );
}

/** Caregiver: the board, the link landing, and the caregiver's own request outcomes. */
export function OpenShiftsPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const label = useWindowLabel();
  const [params] = useSearchParams();
  const ref = params.get("ref");
  const board = useOpenShiftBoard();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ ref: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const landing = useQuery({
    queryKey: ["aws-open-shift-landing", activeOrganizationId, ref],
    queryFn: async () => (await api.get<{ opening: OpeningLanding | null }>(`/v1/open-shift-board/${encodeURIComponent(ref!)}`, { organizationId: activeOrganizationId })).opening,
    enabled: !!activeOrganizationId && !!ref && /^[0-9a-f-]{36}$/i.test(ref),
  });
  const mine = useQuery({
    queryKey: ["aws-my-open-shift-requests", activeOrganizationId],
    queryFn: async () => (await api.get<{ requests: MyOpenShiftRequest[] }>("/v1/my-open-shift-requests", { organizationId: activeOrganizationId })).requests,
    enabled: !!activeOrganizationId,
  });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["aws-open-shift-board"] }),
    queryClient.invalidateQueries({ queryKey: ["aws-my-open-shift-requests"] }),
    queryClient.invalidateQueries({ queryKey: ["aws-open-shift-landing"] }),
  ]);
  async function request(shiftRef: string) {
    if (busy) return;
    if (!keys.current.has(shiftRef)) keys.current.set(shiftRef, newIdempotencyKey());
    setBusy(shiftRef); setError(null); setNotice(null);
    try {
      await api.post(`/v1/open-shift-board/${encodeURIComponent(shiftRef)}/request`, { organizationId: activeOrganizationId }, { idempotencyKey: keys.current.get(shiftRef)! });
      keys.current.delete(shiftRef);
      setNotice("Request sent. Wait for the office to confirm before working this shift.");
    } catch (cause) {
      keys.current.delete(shiftRef);
      setError({ ref: shiftRef, text: message(cause, "The request was not sent. Check your connection and try again.") });
    } finally { setBusy(null); await refresh(); }
  }
  async function withdraw(shiftRef: string) {
    if (busy) return;
    setBusy(shiftRef); setError(null); setNotice(null);
    try {
      await api.post(`/v1/open-shift-board/${encodeURIComponent(shiftRef)}/withdraw`, { organizationId: activeOrganizationId });
      setNotice("Request withdrawn.");
    } catch (cause) {
      setError({ ref: shiftRef, text: message(cause, "The request was not withdrawn. Try again.") });
    } finally { setBusy(null); await refresh(); }
  }
  const outcomes = (mine.data ?? []).filter((r) => r.outcome !== "withdrawn");
  const land = landing.data;
  return (
    <div className="max-w-xl space-y-3">
      <h1 className="text-xl font-semibold text-slate-950">Open shifts</h1>
      <Hint details="You are not assigned until the office confirms. Requests do not hold your hours." show>Asking does not give you the shift.</Hint>
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      {ref && landing.isSuccess ? (
        <p role="status" data-testid="landing-status" className="rounded-lg border border-slate-200 bg-og-card p-2 text-sm">
          {land?.state === "available" ? `The opening from your text is below${land.serviceCity ? ` (${land.serviceCity})` : ""}.` : null}
          {land?.state === "requested" ? "You have requested this shift. Wait for the office to confirm." : null}
          {land?.state === "confirmed" ? "You are confirmed for this shift. See My shifts." : null}
          {land?.state === "filled" ? "This shift was filled." : null}
          {land?.state === "changed" ? "This shift changed. Review the new details and request it again." : null}
          {!land || land.state === "unavailable" ? "This opening is no longer available. Other openings are below." : null}
        </p>
      ) : null}
      {board.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {board.isError ? <p role="alert" className="text-sm text-red-700">Open shifts could not be loaded. Refresh the page.</p> : null}
      {board.data && board.data.length === 0 ? <p data-testid="board-empty" className="text-sm text-slate-600">No open shifts in the cities you cover right now. Check back later.</p> : null}
      <ul className="space-y-1.5">
        {(board.data ?? []).map((s) => (
          <li key={s.shiftRef} data-testid="board-shift" className={`rounded-lg border p-2 ${ref === s.shiftRef ? "border-sky-500 bg-sky-50" : "border-sky-200 bg-sky-50"}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="font-semibold text-slate-950">{s.serviceCity ?? "City not set"}</p>
                <p className="text-sm text-slate-800">{label(s.startsAt, s.endsAt)}</p>
              </div>
              {s.myRequestStatus === "requested" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid="requested-badge" className={`rounded-full px-3 py-1 text-sm font-semibold ${OUTCOME_LABEL.requested.tone}`}>Requested</span>
                  <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} loading={busy === s.shiftRef} onClick={() => void withdraw(s.shiftRef)}>Withdraw request</Button>
                </div>
              ) : (
                <Button type="button" className="min-h-11" disabled={busy !== null} loading={busy === s.shiftRef} onClick={() => void request(s.shiftRef)}>Request this shift</Button>
              )}
            </div>
            {error?.ref === s.shiftRef ? <p role="alert" className="mt-1 text-sm text-red-700">{error.text}</p> : null}
          </li>
        ))}
      </ul>
      {outcomes.length > 0 ? (
        <section aria-labelledby="my-requests-heading" className="space-y-1.5">
          <h2 id="my-requests-heading" className="text-base font-semibold text-slate-950">Your requests</h2>
          <ul className="space-y-1.5">
            {outcomes.map((r) => (
              <li key={`${r.shiftRef}-${r.requestedAt}`} data-testid="my-request" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-og-card p-2 text-sm">
                <span>{r.serviceCity ?? ""} · {label(r.startsAt, r.endsAt)}</span>
                <span data-testid={`outcome-${r.outcome}`} className={`rounded-full px-3 py-1 font-semibold ${OUTCOME_LABEL[r.outcome].tone}`}>{OUTCOME_LABEL[r.outcome].text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConsentCard />
    </div>
  );
}
