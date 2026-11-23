// Writes static preview pages of the branded invitation email (no AWS access, no personal data: the placeholders are filled with SAMPLE values).
// Usage: pnpm --filter @carelik/infra-aws exec tsx scripts/preview-invitation-email.ts <output-directory>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCognitoTemplate, COGNITO_PASSWORD, COGNITO_USERNAME, renderInvitationEmail, type InvitationBranding } from "../lib/invitation-email.js";

const out = process.argv[2];
if (!out) throw new Error("Give an output directory.");
mkdirSync(out, { recursive: true });
const base: InvitationBranding = { companyName: "SoCal Care Services", signInUrl: "https://app.ogevia.com", supportEmail: "help@example.org" };
const variants: Record<string, InvitationBranding> = {
  "company-default": base,
  "company-with-logo": { ...base, logoUrl: "https://app.ogevia.com/logo-sample.png", accentColor: "#14532d" },
  "office-branded": { ...base, office: { name: "Temecula Office", color: "#9a3412" } },
  "long-company-name": { ...base, companyName: "Inland Empire Community Care and Support Services" },
};
for (const [name, brand] of Object.entries(variants)) {
  const r = renderInvitationEmail(brand);
  assertCognitoTemplate(r);
  // Sample values only, so the page looks like the delivered email.
  writeFileSync(join(out, `${name}.html`), r.html.split(COGNITO_USERNAME).join("sample.person@example.org").split(COGNITO_PASSWORD).join("Sample-Temp-1234!"));
}
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Invitation email previews</title><h1>Invitation email previews (sample values)</h1><ul>${Object.keys(variants).map((n) => `<li><a href="${n}.html">${n}</a></li>`).join("")}</ul>`);
console.log(`wrote ${Object.keys(variants).length} previews to ${out}`);
