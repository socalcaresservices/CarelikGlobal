import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useAwsApi } from "./aws-workspace";
import { AwsProtectedRoute } from "./aws-auth-pages";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE = "ogevia.checkin.pending";
const TOKEN_LIFETIME_MS = 10 * 60_000;

export function QrSignInGate({ children }: { children: React.ReactNode }) {
  // Run before the protected route redirects to login. The auth return path carries no token.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.location.pathname === "/checkin" && window.location.hash) {
      const token = window.location.hash.slice(1);
      try {
        sessionStorage.removeItem(STORAGE);
        if (TOKEN.test(token)) sessionStorage.setItem(STORAGE, JSON.stringify({ token, expires: Date.now() + TOKEN_LIFETIME_MS }));
      } catch { /* The lookup stays unavailable when session storage is blocked. */ }
      window.history.replaceState(window.history.state, "", "/checkin");
    }
    setReady(true);
  }, []);
  return ready ? <AwsProtectedRoute>{children}</AwsProtectedRoute> : null;
}

export function ClientQrCard({ clientId }: { clientId: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [printToken, setPrintToken] = useState<string | null>(null);
  const printCard = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const key = ["client-qr", activeOrganizationId, clientId];
  const send = (action: string) => api.post<{ active: boolean; exists: boolean; token?: string }>(
    `/v1/clients/${clientId}/qr-card`, { organizationId: activeOrganizationId, action });
  const status = useQuery({ queryKey: key, queryFn: () => send("status"), enabled: !!activeOrganizationId && expanded });
  const change = useMutation({
    mutationFn: send,
    onSuccess: async (card, action) => {
      if (action === "reprint" && card.token) setPrintToken(card.token);
      setNotice(action === "revoke" ? "QR code revoked." : action === "reprint" ? "Card ready to print." : "QR code ready.");
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const act = (action: string) => { setPrintToken(null); setNotice(""); change.mutate(action); };
  function print() {
    if (!printCard.current) return;
    const page = window.open("about:blank", "_blank");
    if (!page) { setNotice("Allow pop-ups to print the QR card."); return; }
    page.opener = null;
    page.document.title = "Ogevia Client QR Card";
    const style = page.document.createElement("style");
    style.textContent = "@page { margin: 0; } body { margin: 1in; font-family: sans-serif; } svg { display: block; }";
    page.document.head.append(style);
    page.document.body.append(page.document.importNode(printCard.current, true));
    page.focus();
    page.print();
  }
  return <Card>
    <details onToggle={(event) => { setExpanded(event.currentTarget.open); if (!event.currentTarget.open) setPrintToken(null); }}>
    <summary className="cursor-pointer font-semibold">Client QR Card</summary>
    {expanded && status.isPending ? <p>Loading QR card…</p> : null}
    {status.isError || change.isError ? <p role="alert">The QR card action could not be completed.</p> : null}
    {status.data ? <div className="flex flex-wrap gap-2">
      {!status.data.exists ? <Button disabled={change.isPending} onClick={() => act("generate")}>Generate QR</Button> : null}
      {status.data.active ? <>
        <Button disabled={change.isPending} onClick={() => act("reprint")}>Print or reprint QR</Button>
        <Button disabled={change.isPending} onClick={() => { if (window.confirm("Revoke this printed code?")) act("revoke"); }}>Revoke QR</Button>
      </> : null}
      {status.data.exists ? <Button disabled={change.isPending} onClick={() => {
        if (!status.data.active || window.confirm("Replace this code and invalidate all earlier cards?")) act("regenerate");
      }}>Regenerate QR</Button> : null}
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {printToken ? <>
      <style>{`@media print {
        @page { margin: 0; }
        #root :not(:has(.client-qr-print)):not(.client-qr-print):not(.client-qr-print *) { display: none !important; }
        .client-qr-print, .client-qr-print * { visibility: visible !important; }
        .client-qr-print { position: absolute !important; left: 0; top: 0; }
      }`}</style>
      <div ref={printCard} className="client-qr-print bg-white p-4 text-black">
        <p>{activeOrganization?.displayName}</p>
        <p>Scan To Start or End Your Visit</p>
        <QRCodeSVG value={`${window.location.origin}/checkin#${printToken}`} size={240} marginSize={4} />
      </div>
      <Button onClick={print}>Print card</Button>
      <Button onClick={() => setPrintToken(null)}>Close print preview</Button>
    </> : null}
    </details>
  </Card>;
}

type Checkin = {
  state: "unavailable" | "empty" | "scheduled" | "active" | "confirmation";
  organizationId?: string;
  clientCode?: string;
  visitId?: string;
  shifts?: { id: string; startsAt: string; endsAt: string }[];
};
function pendingToken(): string | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null");
    if (pending?.expires > Date.now() && typeof pending.token === "string" && TOKEN.test(pending.token)) return pending.token;
    sessionStorage.removeItem(STORAGE);
  } catch { /* Invalid or unavailable browser storage. */ }
  return null;
}

export function ClientQrCheckin() {
  const api = useAwsApi();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { setActiveOrganizationId } = useOrganization();
  const [token] = useState(pendingToken);
  const [shift, setShift] = useState("");
  const request = useRef<{ shift: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const lookup = useQuery({
    queryKey: ["qr-checkin"],
    queryFn: () => api.post<Checkin>("/v1/checkin", { token }),
    enabled: !!token,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
  const result = lookup.data;
  const action = useMutation({
    mutationFn: async () => {
      if (!token || !result?.organizationId) return;
      if (result.state === "active") {
        if (!result.visitId) return;
        const ended = await api.post<Checkin>("/v1/checkin", { token, visitId: result.visitId });
        if (ended.state !== "confirmation") throw new Error("Unable to end this visit.");
      } else if (result.state === "scheduled") {
        const selected = result.shifts?.length === 1 ? result.shifts[0]?.id : shift;
        if (!selected) return;
        if (request.current?.shift !== selected) request.current = { shift: selected, key: newIdempotencyKey() };
        const started = await api.post<Checkin>("/v1/checkin", { token, shiftId: selected }, { idempotencyKey: request.current.key });
        if (started.state !== "active") throw new Error("No scheduled visit found.");
      }
      setActiveOrganizationId(result.organizationId);
      await cache.invalidateQueries({ queryKey: ["active-service-visit-v3"] });
      try { sessionStorage.removeItem(STORAGE); } catch { /* Storage may be unavailable. */ }
      navigate("/service-verification", { replace: true });
    },
  });
  return <Card>
    <h1 className="text-xl font-semibold">Visit check-in</h1>
    {!token || result?.state === "unavailable" ? <p>Unable to find an eligible visit.</p> : null}
    {token && lookup.isPending ? <p>Checking your schedule…</p> : null}
    {lookup.isError ? <p role="alert">Could not check your schedule. <button onClick={() => void lookup.refetch()}>Try again</button></p> : null}
    {result?.state === "empty" ? <p>No scheduled visit found.</p> : null}
    {result && (result.state === "scheduled" || result.state === "active" || result.state === "confirmation") ? <>
      <p>Client {result.clientCode}</p>
      {result.state === "scheduled" && result.shifts?.length === 1 ? <p>{new Date(result.shifts[0]!.startsAt).toLocaleString()}</p> : null}
      {result.state === "scheduled" && (result.shifts?.length ?? 0) > 1 ? <label>Choose a shift
        <select value={shift} onChange={(event) => setShift(event.target.value)}>
          <option value="">Choose a shift</option>
          {result.shifts?.map((item) => <option key={item.id} value={item.id}>{new Date(item.startsAt).toLocaleString()} – {new Date(item.endsAt).toLocaleTimeString()}</option>)}
        </select>
      </label> : null}
      <Button disabled={action.isPending || lookup.isFetching || (result.state === "scheduled" && (result.shifts?.length ?? 0) > 1 && !shift)}
        onClick={() => {
          if (inFlight.current) return;
          inFlight.current = true;
          void action.mutateAsync().catch(() => {}).finally(() => { inFlight.current = false; });
        }}>{result.state === "active" ? "End Visit" : result.state === "confirmation" ? "Continue to confirmation" : "Start Visit"}</Button>
    </> : null}
    {action.isError ? <p role="alert">The visit action could not be confirmed. Check your connection and try again.</p> : null}
  </Card>;
}
