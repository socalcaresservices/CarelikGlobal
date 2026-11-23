// Invitation email look (0114, behind the `invitationBranding` release switch): each office's accent colour, logo address and help address, with a live preview of the
// invitation and password-reset emails. The preview is drawn in this browser from the same renderer the sign-in service uses, with SAMPLE values: nothing is sent.
// Where the switch is off the list does not load and this renders nothing. Nothing here changes an office, a person or a sign-in.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { renderInvitationEmail, renderPasswordResetEmail, type InvitationBranding } from "@carelik/shared";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

interface Row { office_id: string; office_name: string; accent_color: string | null; logo_url: string | null; support_email: string | null }
const inputClass = "mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base";
const HEX = /^#[0-9a-fA-F]{6}$/;
const sample = (company: string, d: { color: string; logo: string; mail: string; office: string }, kind: "invite" | "reset") => {
  const b: InvitationBranding = {
    companyName: company, signInUrl: "https://app.example.org",
    ...(HEX.test(d.color) ? { accentColor: d.color } : {}),
    ...(/^https:\/\/[^\s"'<>{}]+$/.test(d.logo) ? { logoUrl: d.logo } : {}),
    ...(/^[^\s@<>"{}]+@[^\s@<>"{}]+\.[^\s@<>"{}]+$/.test(d.mail) ? { supportEmail: d.mail } : {}),
    ...(d.office ? { office: { name: d.office, ...(HEX.test(d.color) ? { color: d.color } : {}) } } : {}),
  };
  const r = kind === "invite" ? renderInvitationEmail(b) : renderPasswordResetEmail(b);
  return { subject: r.subject, html: r.html.split("{username}").join("sample.person@example.org").split("{####}").join("Sample-Temp-1234!") };
};

export function InvitationLook({ companyName }: { companyName: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const q = useQuery({ queryKey: ["office-branding", activeOrganizationId], queryFn: async () => (await api.get<{ offices: Row[] }>("/v1/office-branding", { organizationId: activeOrganizationId })).offices, enabled: !!activeOrganizationId, retry: false });
  const [officeId, setOfficeId] = useState("");
  const [draft, setDraft] = useState<{ color: string; logo: string; mail: string } | null>(null);
  const [kind, setKind] = useState<"invite" | "reset">("invite");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!q.isSuccess) return null;   // switch off (or not loaded): no controls
  const offices = q.data;
  if (offices.length === 0) return null;
  const current = offices.find((o) => o.office_id === officeId) ?? offices[0]!;
  const d = draft ?? { color: current.accent_color ?? "", logo: current.logo_url ?? "", mail: current.support_email ?? "" };
  const canEdit = hasPermission("organization.update");
  const preview = sample(companyName, { ...d, office: current.office_name }, kind);
  const invalid = (d.color && !HEX.test(d.color)) ? "Colour must look like #0F5F66." : (d.logo && !/^https:\/\//.test(d.logo)) ? "The logo must be an https address." : null;
  async function save() {
    setNote(null);
    if (invalid) { setNote({ ok: false, text: invalid }); return; }
    try {
      await api.post(`/v1/offices/${current.office_id}/branding`, { organizationId: activeOrganizationId, accentColor: d.color || null, logoUrl: d.logo || null, supportEmail: d.mail || null }, { idempotencyKey: newIdempotencyKey() });
      setDraft(null); await queryClient.invalidateQueries({ queryKey: ["office-branding"] }); setNote({ ok: true, text: "Saved. New invitations for this office's caregivers use this look." });
    } catch (cause) { setNote({ ok: false, text: cause instanceof Error ? cause.message : "Could not save. Nothing changed." }); }
  }
  return (
    <Card>
      <h2 className="text-base font-semibold text-og-ink">Invitation email look</h2>
      <p className="mt-1 text-sm text-og-sub">A caregiver's invitation uses the look of their primary office; an office with no look uses the company's. The logo is an https address your agency hosts. This preview uses sample names and codes; nothing is sent.</p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm">Office
            <select className={inputClass} value={current.office_id} onChange={(e) => { setOfficeId(e.target.value); setDraft(null); setNote(null); }} data-testid="look-office">
              {offices.map((o) => <option key={o.office_id} value={o.office_id}>{o.office_name}</option>)}
            </select>
          </label>
          <label className="text-sm">Accent colour<input className={inputClass} value={d.color} placeholder="#0F5F66" disabled={!canEdit} onChange={(e) => setDraft({ ...d, color: e.target.value })} data-testid="look-color" /></label>
          <label className="text-sm">Logo address (https)<input className={inputClass} value={d.logo} placeholder="https://" disabled={!canEdit} onChange={(e) => setDraft({ ...d, logo: e.target.value })} data-testid="look-logo" /></label>
          <label className="text-sm">Help email shown in the email<input className={inputClass} value={d.mail} disabled={!canEdit} onChange={(e) => setDraft({ ...d, mail: e.target.value })} data-testid="look-mail" /></label>
          {canEdit ? <Button onClick={() => void save()}>Save look</Button> : <p className="text-xs text-og-sub">Only the agency Administrator can change this.</p>}
          {note ? <p role={note.ok ? "status" : "alert"} className={`text-sm ${note.ok ? "text-og-sub" : "text-red-700"}`}>{note.text}</p> : null}
        </div>
        <div>
          <div className="flex gap-2" role="group" aria-label="Preview of">
            <Button variant={kind === "invite" ? "primary" : "secondary"} onClick={() => setKind("invite")}>Invitation</Button>
            <Button variant={kind === "reset" ? "primary" : "secondary"} onClick={() => setKind("reset")}>Password reset</Button>
          </div>
          <p className="mt-1 text-xs text-og-sub" data-testid="look-subject">Subject: {preview.subject}</p>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="mt-1 h-96 w-full rounded-lg border border-og-line bg-white" data-testid="look-preview" />
        </div>
      </div>
    </Card>
  );
}
