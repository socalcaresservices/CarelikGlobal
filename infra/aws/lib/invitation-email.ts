/**
 * Branded sign-in invitation email (Phase 7.2). A pure renderer: no network, no AWS calls, no personal data.
 *
 * Cognito sends the invitation (AdminCreateUser / resend). Cognito fills exactly two placeholders in the body: {username} (the person's email,
 * because the pool uses email as the username) and {####} (the temporary password). Everything else here is fixed at deploy time, so one pool
 * means one brand per deployment. Per-office branding needs a Cognito "custom message" trigger and is NOT BUILT; `office` is accepted so the
 * same renderer can serve that trigger later (see docs/stabilization/feature-readiness.md and branded-invitation-emails.md).
 *
 * Email-client rules followed: table layout, inline styles, 600 px max width with a narrow-screen media query, bulletproof button, no scripts,
 * no remote CSS, the only remote asset is the optional logo (https), and a plain-text fallback line under the button.
 */
export interface InvitationBranding {
  /** Shown in the subject, header and footer, e.g. "SoCal Care Services". */
  readonly companyName: string;
  /** Optional https logo URL (max 200 px wide). Without it the company name is shown as text. */
  readonly logoUrl?: string;
  /** Header and button colour, #RRGGBB. Default is a dark teal with 4.5:1 contrast against white text. */
  readonly accentColor?: string;
  /** Where the person signs in (the app address). Shown as the button target and as visible text. */
  readonly signInUrl: string;
  /** Optional help address shown in the footer (display only; this is not the sender). */
  readonly supportEmail?: string;
  /** Optional office name and colour (the future per-office trigger); shown as a small line under the header. */
  readonly office?: { readonly name: string; readonly color?: string };
}

export interface RenderedInvitationEmail { readonly subject: string; readonly html: string; readonly text: string }

export const COGNITO_USERNAME = "{username}";
export const COGNITO_PASSWORD = "{####}";
const DEFAULT_ACCENT = "#0f5f66";
const HEX = /^#[0-9a-fA-F]{6}$/;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Throws a plain error naming the field (never the value of a secret: there are none here). */
export function validateBranding(b: InvitationBranding): void {
  if (!b.companyName.trim() || b.companyName.length > 60) throw new Error("invitation email: companyName must be 1 to 60 characters");
  if (/[\r\n{}]/.test(b.companyName) || (b.office && /[\r\n{}]/.test(b.office.name))) throw new Error("invitation email: names must not contain line breaks or braces (they would break Cognito's placeholders)");
  if (b.accentColor !== undefined && !HEX.test(b.accentColor)) throw new Error("invitation email: accentColor must be #RRGGBB");
  if (b.office?.color !== undefined && !HEX.test(b.office.color)) throw new Error("invitation email: office colour must be #RRGGBB");
  if (!/^https:\/\/[^\s"'<>{}]+$/.test(b.signInUrl)) throw new Error("invitation email: signInUrl must be an https address");
  if (b.logoUrl !== undefined && !/^https:\/\/[^\s"'<>{}]+$/.test(b.logoUrl)) throw new Error("invitation email: logoUrl must be an https address");
  if (b.supportEmail !== undefined && !/^[^\s@<>"{}]+@[^\s@<>"{}]+\.[^\s@<>"{}]+$/.test(b.supportEmail)) throw new Error("invitation email: supportEmail is not an email address");
}

export function renderInvitationEmail(b: InvitationBranding): RenderedInvitationEmail {
  validateBranding(b);
  const accent = b.accentColor ?? DEFAULT_ACCENT;
  const company = esc(b.companyName);
  const url = esc(b.signInUrl);
  const subject = `You're invited to ${b.companyName} on Ogevia`;
  const header = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${company}" width="160" style="display:block;border:0;max-width:160px;height:auto;margin:0 auto">`
    : `<span style="font-size:22px;font-weight:700;color:#ffffff">${company}</span>`;
  const office = b.office ? `<tr><td style="padding:6px 24px;background:${esc(b.office.color ?? accent)};color:#ffffff;font-size:13px;text-align:center">${esc(b.office.name)}</td></tr>` : "";
  const help = b.supportEmail ? `<p style="margin:12px 0 0">Need help? Write to ${esc(b.supportEmail)}.</p>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title>
<style>@media only screen and (max-width:480px){.wrap{width:100% !important}.pad{padding:20px 16px !important}.btn a{display:block !important}}</style></head>
<body style="margin:0;padding:0;background:#f3f5f6;font-family:Arial,Helvetica,sans-serif;color:#1d2a2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f6"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td align="center" style="background:${esc(accent)};padding:20px 24px">${header}</td></tr>${office}
<tr><td class="pad" style="padding:28px 32px;font-size:16px;line-height:1.5">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#1d2a2e">Your sign-in is ready</h1>
<p style="margin:0 0 12px">${company} has invited you to Ogevia, where you see your schedule and record your visits.</p>
<p style="margin:0 0 4px"><strong>Your sign-in name</strong><br>${COGNITO_USERNAME}</p>
<p style="margin:12px 0 4px"><strong>Your temporary password</strong><br><span style="font-family:Consolas,Menlo,monospace;font-size:18px;letter-spacing:1px">${COGNITO_PASSWORD}</span></p>
<p style="margin:12px 0 20px;font-size:14px;color:#4a5a5f">It works once and expires in 7 days. You will choose your own password the first time you sign in.</p>
<table role="presentation" class="btn" cellpadding="0" cellspacing="0"><tr><td style="background:${esc(accent)};border-radius:6px"><a href="${url}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none">Sign in to Ogevia</a></td></tr></table>
<p style="margin:16px 0 0;font-size:13px;color:#4a5a5f">If the button does not work, open this address: ${url}</p>
${help}
</td></tr>
<tr><td style="padding:16px 32px;background:#f3f5f6;font-size:12px;line-height:1.5;color:#4a5a5f">You received this because ${company} created a sign-in for you. If you were not expecting it, do not use the password; tell ${company}.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${b.companyName} has invited you to Ogevia.\nSign-in name: ${COGNITO_USERNAME}\nTemporary password: ${COGNITO_PASSWORD} (works once; expires in 7 days)\nSign in: ${b.signInUrl}`;
  return { subject, html, text };
}

/** The Cognito message-template limits (documented: subject up to 140 chars, body up to 20,000, and both placeholders required). */
export function assertCognitoTemplate(t: RenderedInvitationEmail): void {
  if (t.subject.length > 140) throw new Error("invitation email: subject is longer than Cognito allows (140)");
  if (t.html.length > 20000) throw new Error("invitation email: body is longer than Cognito allows (20000)");
  for (const p of [COGNITO_USERNAME, COGNITO_PASSWORD]) if (!t.html.includes(p)) throw new Error(`invitation email: the body must contain ${p}`);
  if (t.html.split(COGNITO_PASSWORD).length !== 2) throw new Error("invitation email: the temporary password placeholder must appear exactly once");
}
