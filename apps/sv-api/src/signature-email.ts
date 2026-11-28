// The signing-link email (0124 follow-up). It carries ONE thing: a link. Never the 6-digit code (the agency gives that by phone), never a client or caregiver name,
// service, date or time, and nothing visit-specific in the subject. The recipient's own address is used once to send and is not stored or logged.
export interface SignatureEmailInput { readonly agencyName: string; readonly url: string; readonly expiresAt: Date }
export interface ComposedEmail { readonly subject: string; readonly text: string; readonly html: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function composeSignatureEmail(input: SignatureEmailInput): ComposedEmail {
  const when = day(input.expiresAt);
  const agency = input.agencyName.replace(/[\r\n]+/g, " ").slice(0, 120);
  const lines = [
    `${agency} asks you to review and confirm a care visit.`,
    `1. Open this link: ${input.url}`,
    "2. Enter the 6-digit code the agency gave you by phone.",
    `The link works once and stops working after ${when}. If you were not expecting this message, do not open the link; please contact the agency.`,
    "For your protection this email does not include the code or any details of the visit.",
  ];
  const html = `<!doctype html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2a2e;line-height:1.5;max-width:560px">`
    + `<p style="font-size:18px;font-weight:700">Please confirm a care visit</p>`
    + `<p>${esc(agency)} asks you to review and confirm a care visit.</p>`
    + `<ol style="padding-left:20px"><li style="margin-bottom:8px">Open this link: <a href="${esc(input.url)}">${esc(input.url)}</a></li><li>Enter the 6-digit code the agency gave you by phone.</li></ol>`
    + `<p>The link works once and stops working after ${esc(when)}. If you were not expecting this message, do not open the link; please contact the agency.</p>`
    + `<p style="color:#556">For your protection this email does not include the code or any details of the visit.</p></body></html>`;
  return { subject: "Please confirm a care visit", text: lines.join("\n\n"), html };
}
