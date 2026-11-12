import { useState } from "react";

/** A reusable entry address, never an invitation token or a login callback URL. */
export function CaregiverAccessHelp() {
  const address = `${window.location.origin}/service-verification`;
  const [message, setMessage] = useState("");
  return <details className="mt-4 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <summary className="min-h-11 cursor-pointer font-semibold text-slate-900">Save Ogevia on your phone · Sign-in help</summary>
    <p className="mt-2">Use this same address each time. After sign-in, your assigned visits appear here.</p>
    <a className="mt-2 block break-all text-og-link underline" href={address}>{address}</a>
    <button className="mt-2 min-h-11 rounded-lg border border-slate-300 px-3 font-medium" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(address); setMessage("App address copied."); }
      catch { setMessage("Copy the app address shown above."); }
    }}>Copy app address</button>
    {message ? <p role="status">{message}</p> : null}
    <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
      <li><strong>iPhone:</strong> open the address in Safari, tap Share, then Add to Home Screen.</li>
      <li><strong>Android:</strong> open it in Chrome, open the browser menu, then Add to Home screen. Browser wording may vary.</li>
      <li><strong>First sign-in:</strong> use the invitation email from your office and complete the password steps. Save the app address above, rather than the invitation.</li>
      <li><strong>Invitation expired or missing?</strong> ask the office to confirm your email address and resend the invitation. Check your spam folder.</li>
      <li><strong>No assigned visits?</strong> ask the office to check your client, service and schedule assignment.</li>
    </ul>
  </details>;
}
