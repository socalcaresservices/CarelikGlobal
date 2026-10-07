// The recipient's page for confirming a visit later (0036). No account: the
// link token (in the URL fragment, never sent to the web server) plus the
// 6-digit code the agency gave by phone. Shows only what is needed to confirm:
// agency, service, date, times, worked time and the caregiver's first name.
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { formatClockTime, formatDateOnly, formatDuration, setAgencyTimeZone } from "@/lib/service-verification";
import { SignaturePad } from "@/components/signature-pad";
import { useLinkToken } from "./care-public-pages";

interface VisitToConfirm {
  agencyName: string;
  recipientName: string;
  serviceName: string;
  serviceDate: string;
  timeIn: string;
  timeOut: string;
  workedMinutes: number;
  caregiverFirstName: string;
  timezone: string;
  expiresAt: string;
  attemptsLeft: number;
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-3 text-base";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6">
      <main className="mx-auto max-w-lg space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">{title}</h1>
          <p className="text-xs uppercase tracking-wide text-slate-400">Visit confirmation · Powered by Ogevia</p>
        </div>
        {children}
      </main>
    </div>
  );
}

export function ConfirmVisitPage({ api }: { api: AwsApiClient }) {
  const token = useLinkToken();
  const [code, setCode] = useState("");
  const [visit, setVisit] = useState<VisitToConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<"confirmed" | "disputed" | null>(null);
  const [method, setMethod] = useState<"draw" | "typed">("draw");
  const [name, setName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [dispute, setDispute] = useState("");
  const [done, setDone] = useState<"confirmed" | "disputed" | null>(null);
  const responseKey = useRef(crypto.randomUUID());

  if (!token) {
    return <Shell title="Confirm a visit"><Card className="p-4"><p>This link is not complete. Open the full link you were sent, or ask the agency for a new one.</p></Card></Shell>;
  }

  async function open() {
    if (!/^\d{6}$/.test(code)) return setError("Enter the 6-digit code the agency gave you by phone.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ visit: VisitToConfirm }>(`/v1/public/visit-confirmations/${token}/open`, { code });
      setAgencyTimeZone(r.visit.timezone);
      setVisit(r.visit);
      setName(r.visit.recipientName);
    } catch (cause) {
      setError(message(cause, "The code could not be checked. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!visit || !choice) return;
    if (name.trim().length < 2) return setError("Enter your full name.");
    if (choice === "confirmed") {
      if (method === "draw" && !signature) return setError("Sign in the box with your finger.");
      if (!attested) return setError("Tick the box to confirm the visit took place as shown.");
    } else if (dispute.trim().length < 3) {
      return setError("Describe what is wrong with this visit.");
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/public/visit-confirmations/${token}/respond`, {
        code,
        outcome: choice,
        method: choice === "confirmed" ? method : null,
        signerName: name.trim(),
        disputeReason: choice === "disputed" ? dispute.trim() : null,
        attested: choice === "confirmed" ? attested : false,
        signaturePng: choice === "confirmed" && method === "draw" ? signature : null,
        responseKey: responseKey.current,
      });
      setDone(choice);
    } catch (cause) {
      setError(message(cause, "Your answer was not saved. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell title={visit?.agencyName ?? "Visit confirmation"}>
        <Card className="space-y-2 p-4">
          <p className="text-lg font-semibold text-slate-950">{done === "confirmed" ? "Thank you. Your confirmation was sent." : "Thank you. Your report was sent."}</p>
          <p className="text-sm text-slate-700">The agency will review it. You can close this page. This link no longer works.</p>
        </Card>
      </Shell>
    );
  }

  if (!visit) {
    return (
      <Shell title="Confirm a visit">
        <Card className="space-y-3 p-4">
          <p className="text-sm text-slate-700">The agency gave you a 6-digit code by phone. Enter it to see the visit.</p>
          <form onSubmit={(e) => { e.preventDefault(); void open(); }} className="space-y-3">
            <label className="block text-sm font-medium text-slate-700">Code
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className={`${input} font-mono tracking-widest`} />
            </label>
            {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
            <Button type="submit" disabled={busy} className="min-h-11 w-full">Continue</Button>
          </form>
          <p className="text-xs text-slate-500">Did not get a code, or it does not work? Call the agency. Never share the code with anyone else.</p>
        </Card>
      </Shell>
    );
  }

  const times = `${formatClockTime(visit.timeIn)} – ${formatClockTime(visit.timeOut)}`;
  return (
    <Shell title={visit.agencyName}>
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-semibold text-slate-950">Please check this visit</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Service</dt><dd className="font-medium">{visit.serviceName}</dd>
          <dt className="text-slate-500">Date</dt><dd className="font-medium">{formatDateOnly(visit.serviceDate)}</dd>
          <dt className="text-slate-500">Time</dt><dd className="font-medium">{times}</dd>
          <dt className="text-slate-500">Length</dt><dd className="font-medium">{formatDuration(visit.workedMinutes)}</dd>
          <dt className="text-slate-500">Caregiver</dt><dd className="font-medium">{visit.caregiverFirstName}</dd>
        </dl>
      </Card>

      <Card className="space-y-3 p-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Did this visit happen as shown?</legend>
          <label className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 p-3 text-base">
            <input type="radio" name="choice" checked={choice === "confirmed"} onChange={() => setChoice("confirmed")} /> Yes, it happened as shown
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 p-3 text-base">
            <input type="radio" name="choice" checked={choice === "disputed"} onChange={() => setChoice("disputed")} /> No, something is wrong
          </label>
        </fieldset>

        {choice ? (
          <label className="block text-sm font-medium text-slate-700">Your full name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" className={input} />
          </label>
        ) : null}

        {choice === "confirmed" ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button type="button" variant={method === "draw" ? "primary" : "secondary"} onClick={() => setMethod("draw")}>Sign with finger</Button>
              <Button type="button" variant={method === "typed" ? "primary" : "secondary"} onClick={() => { setMethod("typed"); setSignature(null); }}>Type my name instead</Button>
            </div>
            {method === "draw" ? <SignaturePad onChange={setSignature} label="Your signature" /> : <p className="text-sm text-slate-600">Your typed full name above is your confirmation.</p>}
            <label className="flex gap-2 text-sm text-slate-800">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1 h-5 w-5" />
              <span>I confirm that {visit.caregiverFirstName} provided {visit.serviceName} on {formatDateOnly(visit.serviceDate)} from {times}.</span>
            </label>
          </div>
        ) : null}

        {choice === "disputed" ? (
          <label className="block text-sm font-medium text-slate-700">What is wrong?
            <textarea value={dispute} onChange={(e) => setDispute(e.target.value)} maxLength={1000} rows={3} className={input} placeholder="For example: the caregiver left at 3:00 PM" />
          </label>
        ) : null}

        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {choice ? <Button type="button" disabled={busy} onClick={() => void submit()} className="min-h-11 w-full">{choice === "confirmed" ? "Send confirmation" : "Send report"}</Button> : null}
      </Card>
    </Shell>
  );
}
