import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { contrastWithWhite } from "./contrast";
import { prepareLogoFile } from "./document-file";
import { useLogo, useAwsApi, useBranding, useMyDisplayName, useSetMyDisplayName, type Branding } from "./aws-workspace";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** The signed-in person completes or changes their own display name. */
export function ProfilePage() {
  const { displayName } = useMyDisplayName();
  const save = useSetMyDisplayName();
  const [name, setName] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  useEffect(() => setName(displayName ?? ""), [displayName]);

  async function submit() {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 80) {
      setState({ busy: false, error: "Enter a name between 2 and 80 characters.", done: false });
      return;
    }
    setState({ busy: true, error: null, done: false });
    try {
      await save(trimmed);
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Could not save your name."), done: false });
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-950">Your profile</h1>
      <Card className="p-4">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Your name, as your agency sees it
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
          </label>
          {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-sm text-emerald-800">Saved.</p> : null}
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save name"}</Button>
        </form>
      </Card>
    </div>
  );
}

/** Administrator only: agency name and accent colour, applied to every role's header. */
export function BrandingSettingsPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const branding = useBranding();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#0f172a");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => {
    if (branding.data) {
      setName(branding.data.displayName);
      setColor(branding.data.accentColor ?? "#0f172a");
    }
  }, [branding.data]);

  if (!hasPermission("organization.update")) return <p className="text-sm text-slate-600">Only the agency Administrator can change branding.</p>;

  const valid = /^#[0-9a-fA-F]{6}$/.test(color);
  const contrast = valid ? contrastWithWhite(color.toLowerCase()) : null;
  const readable = contrast !== null && contrast >= 4.5;

  async function submit() {
    if (!readable || name.trim().length < 2) {
      setState({ busy: false, error: !readable ? "Choose a darker colour so white text stays readable (4.5:1)." : "Enter the agency name.", done: false });
      return;
    }
    setState({ busy: true, error: null, done: false });
    try {
      await api.post<{ branding: Branding }>("/v1/branding", { organizationId: activeOrganizationId, displayName: name.trim(), accentColor: color.toLowerCase() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await queryClient.invalidateQueries({ queryKey: ["aws-branding"] });
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Could not save branding."), done: false });
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-xl font-semibold text-slate-950">Agency branding</h1>
      <p className="text-sm text-slate-600">Shown to every role in your agency, on phones and desktop. Warning colours (such as NEEDS ATTENTION) stay red.</p>
      <Card className="p-4">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Agency name
            <input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setState((s) => ({ ...s, done: false })); }} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium text-slate-700">
              Accent colour
              <input type="color" value={valid ? color : "#0f172a"} onChange={(e) => setColor(e.target.value)} className="mt-1 block h-10 w-16 rounded border border-slate-200" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Hex
              <input value={color} onChange={(e) => setColor(e.target.value.trim())} maxLength={7} className="mt-1 block w-28 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm" />
            </label>
          </div>
          <p className={readable ? "text-xs text-slate-600" : "text-xs font-semibold text-red-700"}>
            {contrast === null ? "Enter a colour like #1f5f8b." : `White text contrast ${contrast}:1 ${readable ? "(readable)" : "(too light: needs 4.5:1)"}`}
          </p>
          <div aria-label="Preview" className="rounded-lg border border-slate-200 bg-white">
            <div className="h-1 rounded-t-lg" style={{ backgroundColor: valid ? color : "#0f172a" }} />
            <div className="flex items-center justify-between gap-2 p-3">
              <span className="text-sm font-semibold text-slate-950">{name || "Agency name"}</span>
              <span className="rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: valid ? color : "#0f172a" }}>Visit records</span>
            </div>
          </div>
          {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-sm text-emerald-800">Saved. Every role sees it on next load.</p> : null}
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save branding"}</Button>
        </form>
      </Card>
      <LogoSettings />
    </div>
  );
}

/** Administrator-only agency logo: stored privately; shown to every role and on printouts. */
function LogoSettings() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const logo = useLogo();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["aws-branding"] });
    await queryClient.invalidateQueries({ queryKey: ["organization-letterhead"] });
  };
  async function upload() {
    if (!file) return setState({ busy: false, error: "Choose a PNG or JPEG image.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const prepared = await prepareLogoFile(file);
      await api.post("/v1/branding/logo", { organizationId: activeOrganizationId, contentType: prepared.contentType, fileBase64: prepared.base64 }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null, done: "Logo saved." });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The logo was not saved."), done: null });
    }
  }
  async function remove() {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post("/v1/branding/logo/clear", { organizationId: activeOrganizationId });
      await refresh();
      setState({ busy: false, error: null, done: "Logo removed." });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The logo was not removed."), done: null });
    }
  }
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Agency logo</h2>
      {logo.data ? <img src={logo.data} alt="Current agency logo" className="h-14 max-w-[200px] object-contain" /> : <p className="text-sm text-slate-500">No logo yet.</p>}
      <label className="block text-sm font-medium text-slate-700">
        Logo image (PNG or JPEG, up to 512 KB)
        <input type="file" accept="image/png,image/jpeg" onChange={(e) => { setFile(e.target.files?.[0] ?? null); key.current = newIdempotencyKey(); }} className="mt-1 block w-full text-sm" />
      </label>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={state.busy} onClick={() => void upload()}>{state.busy ? "Saving…" : "Save logo"}</Button>
        {logo.data ? <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void remove()}>Remove logo</Button> : null}
      </div>
      <p className="text-xs text-slate-500">Stored privately; only people in your agency can see it. It appears in the header and on printed reports.</p>
    </Card>
  );
}
