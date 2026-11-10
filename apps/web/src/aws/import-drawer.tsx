// R11: import people or clients from a CSV/XLSX file. Check first (nothing is created), then confirm. The file is read in the browser only to send it to the API;
// the API parses, validates and creates in one transaction. No invitation is sent and no sign-in is created.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { ApiRequestError } from "../lib/aws-api";
import { useAwsApi } from "./aws-workspace";
import { Drawer } from "./ui/drawer";

type Kind = "people" | "clients";
type Preview = {
  mode: "preview" | "applied" | "already_imported";
  counts: { total: number; new: number; duplicate: number; invalid: number };
  created: number;
  importedAt?: string;
  rows: Array<{ row: number; status: "duplicate" | "invalid"; message: string }>;
};

const COPY: Record<Kind, { button: string; title: string; template: string; columns: string; noun: string; file: string }> = {
  people: {
    button: "Import from a file", title: "Import staff and caregivers", template: "first_name,last_name,type,email,phone\n", file: "ogevia-people-template.csv", noun: "people",
    columns: "first_name and last_name are required. type is Caregiver (the default) or one of your staff types. email and phone are used to spot people who already exist; caregivers are not given an email here.",
  },
  clients: {
    button: "Import from a file", title: "Import clients", template: "first_name,last_name,city,client_type\n", file: "ogevia-clients-template.csv", noun: "clients",
    columns: "first_name and last_name are required. city and client_type are optional (client_type must be one of your active client types). Client codes are made by Ogevia.",
  },
};

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(file);
  });

const errorText = (cause: unknown) =>
  cause instanceof ApiRequestError && cause.status === 404 ? "Import is not available in this environment yet."
  : cause instanceof Error ? cause.message : "The file could not be checked. Try again.";

export function ImportButton({ kind, onDone }: { kind: Kind; onDone?: (text: string) => Promise<void> | void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const copy = COPY[kind];
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Preview | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);

  const reset = () => { setFile(null); setResult(null); setError(null); setIgnored([]); };
  const close = () => { setOpen(false); reset(); };
  const send = async (confirm: boolean) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const contentBase64 = await readBase64(file);
      const res = await api.post<{ import: Preview; ignoredColumns?: string[] }>(`/v1/imports/${kind}`, { organizationId: activeOrganizationId, fileName: file.name, contentBase64, confirm });
      setResult(res.import); setIgnored(res.ignoredColumns ?? []);
      if (res.import.mode === "applied") {
        await queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("aws-") });
        await onDone?.(`Imported ${res.import.created} ${copy.noun}. No invitations were sent.`);
      }
    } catch (cause) {
      setError(errorText(cause));
      if (confirm) setResult(null);
    } finally { setBusy(false); }
  };
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([copy.template], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = copy.file; a.click();
    URL.revokeObjectURL(url);
  };
  const c = result?.counts;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-[44px] items-center font-semibold text-og-accent underline md:min-h-[32px]">{copy.button}</button>
      <Drawer open={open} title={copy.title} onClose={close}>
        <div className="space-y-3 text-sm text-slate-800">
          <p>Choose a CSV or Excel (.xlsx) file. Nothing is created until you check the file and then confirm.</p>
          <p>{copy.columns}</p>
          <Button type="button" variant="secondary" onClick={downloadTemplate}>Download the template</Button>
          <label className="block font-semibold text-og-ink">
            File
            <input type="file" accept=".csv,.xlsx,text/csv" className="mt-1 block min-h-[44px] w-full text-sm"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }} />
          </label>
          <Button type="button" disabled={!file || busy} onClick={() => void send(false)}>{busy && !result ? "Checking…" : "Check the file"}</Button>
          {error ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">{error}</p> : null}
          {result && c ? (
            <div role="status" className="space-y-2 rounded-md border border-slate-200 bg-og-card p-3" data-testid="import-result">
              {result.mode === "already_imported" ? (
                <p className="font-semibold">This exact file was already imported{result.importedAt ? ` on ${new Date(result.importedAt).toLocaleDateString()}` : ""}. Nothing was created.</p>
              ) : result.mode === "applied" ? (
                <p className="font-semibold text-emerald-900">Imported {result.created}. {c.duplicate > 0 ? `${c.duplicate} already existed and were skipped. ` : ""}No invitations were sent.</p>
              ) : (
                <p className="font-semibold">{c.new} new · {c.duplicate} already exist (skipped) · {c.invalid} need fixing</p>
              )}
              {result.rows.length > 0 ? (
                <ul className="max-h-48 list-disc space-y-0.5 overflow-auto pl-5" data-testid="import-rows">
                  {result.rows.slice(0, 50).map((r) => <li key={r.row}>Row {r.row}: {r.message}</li>)}
                  {result.rows.length > 50 ? <li>…and more. Fix the first ones and check again.</li> : null}
                </ul>
              ) : null}
              {ignored.length > 0 ? <p className="text-og-sub">Columns not used: {ignored.join(", ")}.</p> : null}
              {result.mode === "preview" && c.invalid > 0 ? <p className="text-red-800">Fix the rows above and choose the file again. Nothing has been imported.</p> : null}
              {result.mode === "preview" && c.invalid === 0 && c.new === 0 ? <p>There is nothing new to import.</p> : null}
              {result.mode === "preview" && c.invalid === 0 && c.new > 0 ? (
                <Button type="button" disabled={busy} onClick={() => void send(true)}>{busy ? "Importing…" : `Import ${c.new} new`}</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
