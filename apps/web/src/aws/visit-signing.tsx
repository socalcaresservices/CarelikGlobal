// Sign now or sign later (0124). The recorded date and times are shown to the signer; the caregiver's phone sends strokes with a short-lived session bound to this visit and
// these times. Nothing here saves a checkout (that was saved first) and nothing here changes a time, a status or a billable amount.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useAwsApi } from "./aws-workspace";
import { StrokePad, type Strokes } from "./stroke-pad";

interface Session { sessionId: string; expiresAt: string; serviceDate: string; timeIn: string; timeOut: string }
const ROLES = [["client", "The client"], ["parent", "Parent"], ["guardian", "Guardian"], ["authorized_representative", "Authorized representative"]] as const;
const LATER = [["signing_later", "The client will sign later"], ["client_unavailable", "The client is not available to sign"], ["declined", "The client declined to sign"]] as const;
const fmt = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export function VisitSigning({ organizationId, visitId, onDone }: { organizationId: string; visitId: string; onDone: (outcome: "signed" | "later") => void }) {
  const api = useAwsApi();
  const cache = useQueryClient();
  const [strokes, setStrokes] = useState<Strokes | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number][0]>("client");
  const [relationship, setRelationship] = useState("");
  const [attested, setAttested] = useState(false);
  const [later, setLater] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const session = useQuery({
    queryKey: ["signature-session", visitId], retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async () => (await api.post<{ session: Session }>(`/v1/visits/${visitId}/signature-session`, {})).session,
  });
  const [padKey, setPadKey] = useState(0);
  useEffect(() => { setStrokes(null); }, [padKey]);

  const needsRelationship = role !== "client";
  const ready = !!session.data && !!strokes && name.trim().length >= 2 && attested && (!needsRelationship || relationship.trim().length >= 2) && !state.busy;
  async function save() {
    if (!ready || !session.data || !strokes) return;
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/visits/${visitId}/sign`, { organizationId, sessionId: session.data.sessionId, signerRole: role, signerName: name.trim(), signerRelationship: needsRelationship ? relationship.trim() : null, attested: true, strokes }, { idempotencyKey: key.current });
      await cache.invalidateQueries({ queryKey: ["active-service-visit-v3"] });
      onDone("signed");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "";
      // A spent or replaced session is replaced by a fresh one and the client signs again: the pad is never reused across sessions.
      if (/no longer valid|Open it again/i.test(text)) { key.current = newIdempotencyKey(); setPadKey((n) => n + 1); await session.refetch(); setState({ busy: false, error: "That signing screen expired. Please sign again." }); }
      else setState({ busy: false, error: "The signature could not be saved. Check your connection and try again." });
    }
  }
  async function defer(reason: string) {
    setState({ busy: true, error: null });
    try { await api.post(`/v1/visits/${visitId}/sign-later`, { reasonCode: reason }); await cache.invalidateQueries({ queryKey: ["active-service-visit-v3"] }); onDone("later"); }
    catch { setState({ busy: false, error: "Could not record that. Check your connection and try again." }); }
  }

  if (session.isPending) return <p>Preparing the signing screen…</p>;
  if (session.isError || !session.data) return <p role="alert">The signing screen could not be opened. Your checkout is saved. <button type="button" className="underline" onClick={() => void session.refetch()}>Try again</button></p>;
  const s = session.data;
  return (
    <section aria-label="Client signature" className="space-y-3">
      <div className="rounded-xl bg-slate-50 p-3 text-sm" data-testid="signing-times">
        <p className="font-semibold">Please check the visit before signing</p>
        <p>{day(s.timeIn)}</p>
        <p>Started {fmt(s.timeIn)} · Ended {fmt(s.timeOut)}</p>
      </div>
      {!later ? <>
        <label className="block text-sm font-medium">Name of the person signing
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base" autoComplete="off" />
        </label>
        <label className="block text-sm font-medium">Who is signing
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base">
            {ROLES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </label>
        {needsRelationship ? <label className="block text-sm font-medium">Relationship to the client
          <input value={relationship} onChange={(e) => setRelationship(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base" autoComplete="off" />
        </label> : null}
        <StrokePad key={padKey} onChange={setStrokes} label="Sign here with your finger" />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1 h-5 w-5" />
          <span>I confirm that the date and times shown above are correct and that I signed this myself, now.</span></label>
        <Button type="button" disabled={!ready} onClick={() => void save()} className="min-h-12 w-full">{state.busy ? "Saving…" : "Save signature"}</Button>
        <button type="button" className="min-h-11 text-sm font-semibold underline" onClick={() => setLater(true)}>The client cannot sign right now</button>
      </> : <div className="space-y-2">
        <p className="text-sm">Your checkout time is saved. Choose why there is no signature yet; the office will follow up.</p>
        {LATER.map(([v, t]) => <Button key={v} type="button" disabled={state.busy} onClick={() => void defer(v)} className="min-h-12 w-full">{t}</Button>)}
        <button type="button" className="min-h-11 text-sm font-semibold underline" onClick={() => setLater(false)}>Back to signing</button>
      </div>}
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
    </section>
  );
}
