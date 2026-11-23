import {
  assertCognitoResetTemplate, assertCognitoTemplate, brandingWithOffice, renderInvitationEmail, renderPasswordResetEmail, sanitizeOfficeLook, validateBranding,
  type InvitationBranding,
} from "@carelik/shared";

/**
 * Cognito custom-message trigger (Release Train 2, priority B). Cognito calls it before it sends an invitation (AdminCreateUser, including a resend) or a
 * password-reset code, and the response carries the branded subject and body. It is a pure function of the event and its own environment: no database, no network,
 * no secret, no VPC. Per-office branding arrives as ClientMetadata from the API (see identity-handler.ts). It FAILS OPEN: anything unexpected returns the event
 * unchanged, so Cognito sends its own message and a person is never locked out because of a template. It never logs an address, a code or a password.
 */
export interface CustomMessageEvent {
  triggerSource?: string;
  request?: { userAttributes?: Record<string, string>; codeParameter?: string; usernameParameter?: string; clientMetadata?: Record<string, string> | null };
  response?: { smsMessage?: string | null; emailMessage?: string | null; emailSubject?: string | null };
  [key: string]: unknown;
}

export function brandingFromEnvironment(env: Record<string, string | undefined>): InvitationBranding | null {
  const companyName = env.BRAND_COMPANY?.trim();
  const signInUrl = env.SIGN_IN_URL?.trim();
  if (!companyName || !signInUrl) return null;
  const b: InvitationBranding = {
    companyName, signInUrl,
    ...(env.BRAND_LOGO_URL?.trim() ? { logoUrl: env.BRAND_LOGO_URL.trim() } : {}),
    ...(env.BRAND_ACCENT?.trim() ? { accentColor: env.BRAND_ACCENT.trim() } : {}),
    ...(env.BRAND_SUPPORT_EMAIL?.trim() ? { supportEmail: env.BRAND_SUPPORT_EMAIL.trim() } : {}),
  };
  validateBranding(b);
  return b;
}

export function createCustomMessageHandler(company: InvitationBranding | null, log: (line: string) => void = console.log) {
  return async function handler(event: CustomMessageEvent): Promise<CustomMessageEvent> {
    const source = typeof event?.triggerSource === "string" ? event.triggerSource : "";
    try {
      if (!company || !event.response) return event;
      if (source !== "CustomMessage_AdminCreateUser" && source !== "CustomMessage_ForgotPassword") return event;
      // Cognito's placeholders must be present exactly as it sends them.
      if (event.request?.codeParameter !== "{####}") { log(JSON.stringify({ trigger: source, outcome: "unexpected_placeholder" })); return event; }
      const look = source === "CustomMessage_AdminCreateUser" ? sanitizeOfficeLook(event.request?.clientMetadata ?? {}) : {};
      const branding = brandingWithOffice(company, look);
      const rendered = source === "CustomMessage_AdminCreateUser" ? renderInvitationEmail(branding) : renderPasswordResetEmail(branding);
      if (source === "CustomMessage_AdminCreateUser") assertCognitoTemplate(rendered); else assertCognitoResetTemplate(rendered);
      event.response.emailSubject = rendered.subject;
      event.response.emailMessage = rendered.html;
      log(JSON.stringify({ trigger: source, outcome: "branded", office: Object.keys(look).length > 0 }));
      return event;
    } catch {
      log(JSON.stringify({ trigger: source, outcome: "default_message" }));
      return event;
    }
  };
}
