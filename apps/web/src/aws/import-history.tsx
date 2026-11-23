// Import history and rollback (0115, behind the `importRollback` release switch). Lists earlier imports of this kind (who, when, file name, counts) and lets the person who
// may create these records undo ONE import that nobody has used yet. Rollback is all or nothing and never deletes: the records become Inactive. Renders nothing where the switch is off.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

interface Batch { batch_id: string; kind: "people" | "clients"; file_name: string | null; row_count: number; created_count: number; duplicate_count: number; created_at: string; created_by_name: string | null; can_roll_back: boolean; rolled_back_at: string | null; rolled_back_reason: string | null }

export function ImportHistory({ kind }: { kind: "people" | "clients" }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({ queryKey: ["aws-import-history", activeOrganizationId], queryFn: async () => (await api.get<{ imports: Batch[] }>("/v1/imports", { organizationId: activeOrganizationId })).imports, enabled: !!activeOrganizationId, retry: false });
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.isSuccess) return null;
  const list = q.data.filter((b) => b.kind === kind);
  if (list.length === 0) return <p className="text-og-sub" data-testid="history-none">No imports yet.</p>;
  async function rollback(id: string) {
    if (reason.trim().length < 3) { setNote({ ok: false, text: "A reason is required." }); return; }
    setBusy(true); setNote(null);
    try {
      const r = await api.post<{ result: { state: string; records?: number } }>(`/v1/imports/${id}/rollback`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
      setNote({ ok: true, text: r.result.state === "already_rolled_back" ? "That import was already rolled back." : `Rolled back: ${r.result.records ?? 0} record${r.result.records === 1 ? "" : "s"} set to Inactive.` });
      setTarget(null); setReason("");
      await queryClient.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("aws-") });
    } catch (cause) { setNote({ ok: false, text: cause instanceof Error ? cause.message : "Could not roll back. Nothing was changed." }); }
    finally { setBusy(false); }
  }
  return (
    <section aria-label="Import history" className="space-y-2 border-t border-og-line pt-3">
      <h3 className="font-semibold text-og-ink">Earlier imports</h3>
      <ul className="space-y-2">
        {list.map((b) => (
          <li key={b.batch_id} className="rounded-md border border-og-line bg-og-card p-2" data-testid="import-batch">
            <p className="font-medium">{b.file_name ?? "File"} · {new Date(b.created_at).toLocaleDateString()}{b.created_by_name ? ` · ${b.created_by_name}` : ""}</p>
            <p className="text-og-sub">{b.created_count} created, {b.duplicate_count} skipped of {b.row_count} rows{b.rolled_back_at ? ` · Rolled back ${new Date(b.rolled_back_at).toLocaleDateString()}: ${b.rolled_back_reason}` : ""}</p>
            {b.can_roll_back ? (
              target === b.batch_id ? (
                <div className="mt-1 space-y-1">
                  <label className="block">Reason<input className="mt-1 block w-full rounded-lg border border-og-line px-3 py-2 text-base" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rollback-reason" /></label>
                  <p className="text-xs text-og-sub">Only works if nobody has used these records yet. All of them become Inactive, or none do. Nothing is deleted.</p>
                  <div className="flex gap-2"><Button disabled={busy} onClick={() => void rollback(b.batch_id)}>{busy ? "Rolling back…" : "Roll back this import"}</Button><Button variant="secondary" onClick={() => { setTarget(null); setNote(null); }}>Cancel</Button></div>
                </div>
              ) : <button type="button" className="mt-1 inline-flex min-h-[44px] items-center font-semibold underline md:min-h-[32px]" onClick={() => { setTarget(b.batch_id); setNote(null); }}>Roll back…</button>
            ) : null}
          </li>
        ))}
      </ul>
      {note ? <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-emerald-900" : "text-red-800"}>{note.text}</p> : null}
    </section>
  );
}
