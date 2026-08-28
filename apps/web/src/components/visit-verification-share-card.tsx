import { useState } from "react";
import { Link2 } from "lucide-react";
import { Button, Card } from "@carelik/ui";

function getVisitVerificationUrl() {
  return new URL("/service-verification", window.location.origin).toString();
}

export function VisitVerificationShareCard() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const verificationUrl = getVisitVerificationUrl();

  async function copyLink() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(verificationUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setCopyError("Could not copy automatically. Select and copy the link below.");
    }
  }

  return (
    <Card className="border-indigo-100 bg-indigo-50/40">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-indigo-700 shadow-sm">
              <Link2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-700">
                Caregiver link
              </p>
              <h2 className="text-base font-semibold text-slate-950">Visit Verification Link</h2>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            After you assign a caregiver, send them this reusable link. They sign in with their Ogevia caregiver account and will only see clients and authorized services assigned to them.
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Care Team records without a linked login must be invited and linked before they can use Visit Verification.
          </p>
        </div>

        <Button type="button" size="sm" onClick={copyLink}>
          {copied ? "Copied" : "Copy visit link"}
        </Button>
      </div>

      <label htmlFor="visit-verification-share-link" className="sr-only">
        Visit verification link
      </label>
      <input
        id="visit-verification-share-link"
        aria-label="Visit verification link"
        readOnly
        value={verificationUrl}
        onFocus={(event) => event.currentTarget.select()}
        className="mt-4 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
      />
      {copyError ? <p className="mt-2 text-xs text-red-700">{copyError}</p> : null}
    </Card>
  );
}
