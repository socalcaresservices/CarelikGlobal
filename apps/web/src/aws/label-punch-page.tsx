// Home label landing page (0124): a tap on an NFC sticker or a scan of its QR code opens /l#<token>. Opening it only PREVIEWS: the page asks the server what the person can do here.
// A time is saved only when the person presses "Clock in" or "Clock out" (an explicit authenticated action with a retry key). A repeated scan, a reload or a second phone can
// never turn an arrival into a checkout: the server decides from the preview, and the checkout is a separate, deliberate button.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { AwsProtectedRoute } from "./aws-auth-pages";
import { VisitSigning } from "./visit-signing";

const TOKEN = /^[0-9a-f]{64}$/;
const STORAGE = "ogevia.label.pending";
const TOKEN_LIFETIME_MS = 10 * 60_000;

/** Runs before the protected route redirects to sign-in: keeps the token in this tab only (never in a URL that is sent to the server) and removes it from the address bar. */
export function LabelPunchGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.location.pathname === "/l" && window.location.hash) {
      const token = window.location.hash.slice(1);
      try {
        sessionStorage.removeItem(STORAGE);
        if (TOKEN.test(token)) sessionStorage.setItem(STORAGE, JSON.stringify({ token, expires: Date.now() + TOKEN_LIFETIME_MS }));
      } catch { /* The preview stays unavailable when session storage is blocked. */ }
      window.history.replaceState(window.history.state, "", "/l");
    }
    setReady(true);
  }, []);
  return ready ? <AwsProtectedRoute>{children}</AwsProtectedRoute> : null;
}
function pendingToken(): string | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null");
    if (pending?.expires > Date.now() && typeof pending.token === "string" && TOKEN.test(pending.token)) return pending.token;
    sessionStorage.removeItem(STORAGE);
  } catch { /* Invalid or unavailable browser storage. */ }
  return null;
}

interface Fix { latitude: number; longitude: number; accuracyM: number }
/** The phone location, asked for ONLY at the moment of a punch. Null when it is denied, unavailable or too slow; the punch is still sent and the server records "unavailable". */
function currentFix(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { resolve(null); return; }
    const timer = window.setTimeout(() => resolve(null), 9000);
    navigator.geolocation.getCurrentPosition(
      (p) => { window.clearTimeout(timer); resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy }); },
      () => { window.clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
}

interface Preview {
  state: "unavailable" | "blocked" | "ready";
  action?: "arrival" | "departure" | "choose" | "none";
  reason?: string;
  organizationId?: string;
  clientCode?: string;
  city?: string;
  visit?: { id: string; timeIn: string };
  shifts?: Array<{ id: string; startsAt: string; endsAt: string }>;
}
interface PunchResult {
  outcome: "saved" | "needs_choice" | "needs_confirmation" | "not_saved";
  reason?: string; message?: string; intent: "arrival" | "departure"; visitId?: string; savedAt?: string; locationResult?: string; signing?: "sign_now" | "direct_required" | null;
  choices?: Array<{ id: string; startsAt: string; endsAt: string }>; organizationId?: string; replayed?: boolean;
}
const LOCATION_WORDS: Record<string, string> = {
  within_range: "Your phone location matched the home.",
  outside_range: "Your phone was not at the expected place. The office will review this.",
  unavailable: "Your phone location was not available. The office may ask about this.",
  low_accuracy: "Your phone location was not accurate enough to check. The office may ask about this.",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const stamp = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function LabelPunchPage() {
  const api = useAwsApi();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { setActiveOrganizationId } = useOrganization();
  const [token] = useState(pendingToken);
  const [shift, setShift] = useState("");
  const [result, setResult] = useState<PunchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState<"signed" | "later" | null>(null);
  const inFlight = useRef(false);
  const keys = useRef(new Map<string, string>());      // one retry key per intended action until the server answers

  const preview = useQuery({
    queryKey: ["label-preview"], enabled: !!token, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always",
    queryFn: () => api.post<Preview>("/v1/label-punch/preview", { token }),
  });
  const p = preview.data;
  useEffect(() => { if (p?.organizationId) setActiveOrganizationId(p.organizationId); }, [p?.organizationId, setActiveOrganizationId]);

  async function punch(intent: "arrival" | "departure", extra: { shiftId?: string; confirm?: boolean } = {}) {
    if (inFlight.current || !token) return;
    inFlight.current = true; setBusy(true); setError(null);
    const id = `${intent}:${extra.shiftId ?? ""}:${extra.confirm ? "c" : ""}`;
    if (!keys.current.has(id)) keys.current.set(id, newIdempotencyKey());
    try {
      const fix = await currentFix();
      const answer = await api.post<PunchResult>("/v1/label-punch", { token, intent, ...(extra.shiftId ? { shiftId: extra.shiftId } : {}), ...(extra.confirm ? { confirm: true } : {}),
        ...(fix ? { latitude: fix.latitude, longitude: fix.longitude, accuracyM: Math.round(fix.accuracyM) } : {}) }, { idempotencyKey: keys.current.get(id)! });
      keys.current.delete(id);
      setResult(answer);
      if (answer.outcome === "saved") await cache.invalidateQueries({ queryKey: ["active-service-visit-v3"] });
    } catch {
      // The answer is unknown: nothing is shown as saved, and pressing again reuses the SAME key so a first success is never doubled.
      setError("We could not confirm that this was saved. Check your connection and press the button again. It will not be saved twice.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  if (!token || p?.state === "unavailable") return <Card><h1 className="text-xl font-semibold">Visit check-in</h1><p role="alert" data-testid="denied">{p?.reason === "not_authorized" ? "Your Ogevia account is not set up to use this sticker. Nothing was clocked. Ask the office." : "This label cannot be used. Ask the office for help."}</p></Card>;
  if (preview.isPending) return <Card><h1 className="text-xl font-semibold">Visit check-in</h1><p>Checking your schedule…</p></Card>;
  if (preview.isError || !p) return <Card><h1 className="text-xl font-semibold">Visit check-in</h1><p role="alert">Could not check your schedule. <button type="button" className="underline" onClick={() => void preview.refetch()}>Try again</button></p><p className="text-sm">Nothing was clocked.</p></Card>;

  if (result?.outcome === "saved") {
    const out = result.intent === "departure";
    return <Card>
      <h1 className="text-xl font-semibold" data-testid="saved-title">{out ? "Clock-out saved" : "Clock-in saved"}</h1>
      {result.savedAt ? <p data-testid="saved-time">Saved {stamp(result.savedAt)}</p> : null}
      {result.locationResult ? <p className="text-sm text-slate-700">{LOCATION_WORDS[result.locationResult]}</p> : null}
      {!out ? <Button type="button" className="mt-3 min-h-12" onClick={() => navigate("/service-verification", { replace: true })}>Go to your visit</Button> : null}
      {out && result.signing === "sign_now" && result.visitId && result.organizationId && !signed
        ? <VisitSigning organizationId={result.organizationId} visitId={result.visitId} onDone={setSigned} /> : null}
      {out && result.signing === "direct_required" ? <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">Your clock-out is saved. Because you were away from the home, your office will confirm this visit with the client directly. You can start your next visit.</p> : null}
      {signed === "signed" ? <p role="status" className="mt-3 font-semibold" data-testid="signed-note">Signed {new Date().toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</p> : null}
      {signed === "later" ? <p role="status" className="mt-3 text-sm">Your clock-out is saved. The signature is pending; the office will follow up.</p> : null}
      {out && (signed || result.signing === "direct_required") ? <Button type="button" className="mt-3 min-h-12" onClick={() => navigate("/", { replace: true })}>Done</Button> : null}
    </Card>;
  }

  const chooseShifts = result?.outcome === "needs_choice" ? result.choices : p.action === "choose" ? p.shifts : undefined;
  return <Card>
    <h1 className="text-xl font-semibold">Visit check-in</h1>
    {p.clientCode ? <p>Client {p.clientCode}{p.city ? ` · ${p.city}` : ""}</p> : null}
    {p.state === "blocked" ? <>
      {p.reason === "address_not_current"
        ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm" data-testid="denied">This sticker is for an address that is not the current service address. Nothing was clocked. Ask the office.</p>
        : <><p role="status">{p.reason === "previous_visit_not_finished" ? "Finish the signature on your last visit first." : "You have another visit open. Finish it first."}</p>
          <Button type="button" className="mt-3 min-h-12" onClick={() => navigate("/service-verification")}>Go to your open visit</Button></>}
    </> : null}
    {p.state === "ready" && p.action === "none" ? <p role="status">{p.reason === "no_visit_in_window" ? "No visit is scheduled for you at this time. Nothing was clocked." : "You are not assigned to this client. Nothing was clocked."}</p> : null}
    {p.state === "ready" && p.action === "departure" && p.visit ? <>
      <p>You clocked in at {time(p.visit.timeIn)}.</p>
      {result?.outcome === "needs_confirmation"
        ? <><p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm">{result.message}</p>
          <Button type="button" disabled={busy} className="mt-3 min-h-12 w-full" onClick={() => void punch("departure", { confirm: true })}>Yes, clock out now</Button></>
        : <Button type="button" disabled={busy} className="mt-3 min-h-12 w-full" onClick={() => void punch("departure")}>{busy ? "Saving…" : "Clock out"}</Button>}
    </> : null}
    {p.state === "ready" && (p.action === "arrival" || chooseShifts) ? <>
      {p.action === "arrival" && p.shifts?.[0] ? <p>{stamp(p.shifts[0].startsAt)} – {time(p.shifts[0].endsAt)}</p> : null}
      {chooseShifts && chooseShifts.length > 1 ? <label className="mt-2 block text-sm font-medium">Which visit are you starting?
        <select value={shift} onChange={(e) => setShift(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base">
          <option value="">Choose a visit</option>
          {chooseShifts.map((s) => <option key={s.id} value={s.id}>{stamp(s.startsAt)} – {time(s.endsAt)}</option>)}
        </select></label> : null}
      <Button type="button" disabled={busy || (!!chooseShifts && chooseShifts.length > 1 && !shift)} className="mt-3 min-h-12 w-full"
        onClick={() => void punch("arrival", chooseShifts && chooseShifts.length > 1 ? { shiftId: shift } : {})}>{busy ? "Saving…" : "Clock in"}</Button>
    </> : null}
    {result && result.outcome === "not_saved" ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm" data-testid="not-saved">Not saved. {result.message}</p> : null}
    {error ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm">{error}</p> : null}
  </Card>;
}
