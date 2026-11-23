// R6: people who appear more than once in Staff. A read-only report first. The merge is a short wizard per extra record: review the two records side by side, choose a value for every
// field where they disagree, give a reason, confirm. A merge keeps one record and makes the other inactive (nothing is deleted); a recent merge can be undone while neither record has
// changed since. The server decides everything (match, blockers, conflicts); this only shows it. SYNTHETIC data in tests only.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { ApiRequestError } from "../lib/aws-api";
import { useAwsApi } from "./aws-workspace";

type Dup = {
  groupId: string; matchBasis: "email" | "phone" | "name"; staffKey: string; source: string; profileId: string | null; displayName: string; staffTypeName: string | null;
  contactEmail: string | null; phone: string | null; accessStatus: string | null; canMerge: boolean;
};
type Side = { profileId: string; displayName: string; staffType: string | null; email: string | null; phone: string | null };
type Preview = { keep: Side; duplicate: Side; matchBasis: string | null; conflicts: Array<{ field: string; keep: string | null; duplicate: string | null }>; fills: Array<{ field: string; value: string }>; blockers: string[]; canMerge: boolean };
type MergeRow = { linkId: string; keptName: string; mergedName: string; matchBasis: string; reason: string; mergedAt: string; mergedByName: string | null; hasSnapshot: boolean; reversedAt: string | null; reversedReason: string | null; canUndo: boolean };
const WHY: Record<Dup["matchBasis"], string> = { email: "Same email", phone: "Same phone number", name: "Same name" };
const SOURCE: Record<string, string> = { profile: "Staff profile", caregiver: "Caregiver (Care Team)", member: "Has a sign-in only" };
const FIELD: Record<string, string> = { display_name: "Name", staff_type_id: "Staff type", contact_email: "Email", phone: "Phone" };
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

interface Wizard { group: string; keep: Dup; queue: Dup[]; index: number; choices: Record<string, "keep" | "duplicate">; reason: string; busy: boolean; error: string | null }

export function PossibleDuplicates() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [wiz, setWiz] = useState<Wizard | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["aws-staff-duplicates", activeOrganizationId], enabled: !!activeOrganizationId, retry: false,
    queryFn: async () => (await api.get<{ duplicates: Dup[] }>("/v1/staff/duplicates", { organizationId: activeOrganizationId })).duplicates,
  });
  const current = wiz?.queue[wiz.index];
  const preview = useQuery({
    queryKey: ["aws-staff-merge-preview", activeOrganizationId, wiz?.keep.profileId, current?.profileId], retry: false,
    enabled: !!activeOrganizationId && !!wiz && !!current?.profileId && !!wiz.keep.profileId,
    queryFn: async () => (await api.get<{ preview: Preview }>("/v1/staff/merge-preview", { organizationId: activeOrganizationId, keepProfileId: wiz!.keep.profileId, duplicateProfileId: current!.profileId })).preview,
  });
  // Not released in this environment (the route is not there): show nothing, and never an error for a feature that is simply off.
  if (q.isError && q.error instanceof ApiRequestError && q.error.status === 404) return null;
  if (q.isLoading) return null;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Possible duplicates could not be checked. They are not shown as none.</p>;
  const groups = new Map<string, Dup[]>();
  for (const d of q.data ?? []) groups.set(d.groupId, [...(groups.get(d.groupId) ?? []), d]);

  const start = (group: string, members: Dup[], keep: Dup) => {
    const queue = members.filter((m) => m.staffKey !== keep.staffKey && m.canMerge && m.profileId);
    if (!keep.profileId || !keep.canMerge || queue.length === 0) return;
    setDone(null); setWiz({ group, keep, queue, index: 0, choices: {}, reason: "", busy: false, error: null });
  };
  const p = preview.data;
  const unresolved = p ? p.conflicts.filter((c) => !wiz?.choices[c.field]).map((c) => FIELD[c.field] ?? c.field) : [];
  async function confirm() {
    if (!wiz || !current?.profileId || !wiz.keep.profileId) return;
    setWiz({ ...wiz, busy: true, error: null });
    try {
      await api.post(`/v1/staff/${wiz.keep.profileId}/merge`, { organizationId: activeOrganizationId, duplicateProfileId: current.profileId, reason: wiz.reason.trim(), resolutions: wiz.choices }, { idempotencyKey: newIdempotencyKey() });
      const last = wiz.index + 1 >= wiz.queue.length;
      await queryClient.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("aws-") });
      if (last) { setDone(`Merged ${wiz.queue.length} duplicate ${wiz.queue.length === 1 ? "record" : "records"} into ${wiz.keep.displayName}. Nothing was deleted; the extra ${wiz.queue.length === 1 ? "record is" : "records are"} inactive. You can undo a merge under Recent merges.`); setWiz(null); }
      else setWiz({ ...wiz, index: wiz.index + 1, choices: {}, busy: false, error: null });
    } catch (cause) { setWiz({ ...wiz, busy: false, error: message(cause, "The merge did not complete. Nothing was changed.") }); }
  }

  return (
    <>
      {groups.size > 0 || done ? (
        <details className="rounded-md border border-slate-200 bg-og-card px-3" data-testid="possible-duplicates">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-og-ink md:min-h-[32px]">Possible duplicates ({groups.size})</summary>
          <div className="space-y-3 pb-3 text-sm text-slate-800">
            <p>These people appear more than once. Nothing is merged unless you choose it. A merge keeps one record and makes the other inactive; it never deletes anything.</p>
            {done ? <p role="status" className="rounded-md bg-emerald-50 px-3 py-1.5 text-emerald-900">{done}</p> : null}
            {[...groups.entries()].map(([id, members]) => {
              const mergeable = members.filter((m) => m.canMerge);
              return (
                <section key={id} aria-label={`${WHY[members[0]!.matchBasis]}: ${members[0]!.displayName}`} className="space-y-1 rounded-md border border-slate-200 p-2">
                  <h3 className="font-semibold text-og-ink">{WHY[members[0]!.matchBasis]}</h3>
                  <ul className="space-y-1">
                    {members.map((m) => (
                      <li key={m.staffKey} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-semibold">{m.displayName}</span> · {SOURCE[m.source] ?? m.source}{m.staffTypeName ? ` · ${m.staffTypeName}` : ""}
                          {m.contactEmail ? ` · ${m.contactEmail}` : ""}{m.phone ? ` · ${m.phone}` : ""}
                          {!m.canMerge ? <span className="text-og-sub"> · {m.source === "caregiver" ? "resolve in Care Team" : "has a sign-in or invitation; resolve by hand"}</span> : null}
                        </span>
                        {m.canMerge && mergeable.length > 1 ? (
                          <button type="button" className="inline-flex min-h-[44px] items-center font-semibold text-og-accent underline md:min-h-[32px]" onClick={() => start(id, members, m)}>
                            Keep {m.displayName}, merge the others
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {wiz && wiz.group === id ? (
                    <form className="space-y-2 border-t border-slate-200 pt-2" aria-label="Merge wizard" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
                      <p className="font-semibold text-og-ink" data-testid="wizard-step">Record {wiz.index + 1} of {wiz.queue.length}: review, choose, confirm</p>
                      {preview.isLoading ? <p className="text-og-sub">Checking the two records…</p> : null}
                      {preview.isError ? <p role="alert" className="text-red-800">The two records could not be compared. Nothing was changed.</p> : null}
                      {p ? (
                        <>
                          <div className="overflow-x-auto"><table className="w-full text-left" aria-label="The two records">
                            <thead><tr className="text-xs uppercase tracking-wide text-og-sub"><th scope="col" className="py-1 pr-3">&nbsp;</th><th scope="col" className="py-1 pr-3">Kept</th><th scope="col" className="py-1">Merged into it (becomes inactive)</th></tr></thead>
                            <tbody>
                              {([["Name", p.keep.displayName, p.duplicate.displayName], ["Staff type", p.keep.staffType, p.duplicate.staffType], ["Email", p.keep.email, p.duplicate.email], ["Phone", p.keep.phone, p.duplicate.phone]] as const).map(([label, a, b]) => (
                                <tr key={label} className="border-t border-slate-100"><th scope="row" className="py-1 pr-3 font-medium">{label}</th><td className="py-1 pr-3">{a ?? "—"}</td><td className="py-1">{b ?? "—"}</td></tr>
                              ))}
                            </tbody>
                          </table></div>
                          {p.blockers.length > 0 ? <ul role="alert" className="list-disc space-y-0.5 pl-5 text-red-800" data-testid="wizard-blockers">{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
                          {p.canMerge && p.conflicts.length > 0 ? (
                            <fieldset className="space-y-1" data-testid="wizard-conflicts">
                              <legend className="font-semibold text-og-ink">These differ. Choose the value to keep for each.</legend>
                              {p.conflicts.map((c) => (
                                <div key={c.field} role="radiogroup" aria-label={FIELD[c.field] ?? c.field} className="flex flex-wrap items-center gap-3">
                                  <span className="w-24 font-medium">{FIELD[c.field] ?? c.field}</span>
                                  {(["keep", "duplicate"] as const).map((side) => (
                                    <label key={side} className="inline-flex min-h-[44px] items-center gap-1 md:min-h-[32px]">
                                      <input type="radio" name={`conflict-${c.field}`} checked={wiz.choices[c.field] === side} onChange={() => setWiz({ ...wiz, choices: { ...wiz.choices, [c.field]: side } })} />
                                      {side === "keep" ? c.keep : c.duplicate}
                                    </label>
                                  ))}
                                </div>
                              ))}
                            </fieldset>
                          ) : null}
                          {p.canMerge && p.fills.length > 0 ? <p data-testid="wizard-fills">Missing on the kept record, so it will gain: {p.fills.map((f) => `${FIELD[f.field] ?? f.field} ${f.value}`).join("; ")}.</p> : null}
                          {p.canMerge ? (
                            <label className="block font-semibold text-og-ink">Reason for the merge
                              <input value={wiz.reason} onChange={(e) => setWiz({ ...wiz, reason: e.target.value })} maxLength={500} className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-2" />
                            </label>
                          ) : null}
                        </>
                      ) : null}
                      {wiz.error ? <p role="alert" className="text-red-800">{wiz.error}</p> : null}
                      {p?.canMerge && unresolved.length > 0 ? <p className="text-og-sub">Choose a value for: {unresolved.join(", ")}.</p> : null}
                      <div className="flex gap-2">
                        <Button type="submit" disabled={wiz.busy || !p?.canMerge || unresolved.length > 0 || wiz.reason.trim().length < 5}>{wiz.busy ? "Merging…" : "Merge"}</Button>
                        <Button type="button" variant="secondary" onClick={() => setWiz(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : null}
                </section>
              );
            })}
          </div>
        </details>
      ) : null}
      <RecentMerges />
    </>
  );
}

/** Recent merges, with a guarded undo: only while neither record has changed since the merge (the server checks and says why when it refuses). */
function RecentMerges() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ["aws-staff-merges", activeOrganizationId], enabled: !!activeOrganizationId, retry: false, queryFn: async () => (await api.get<{ merges: MergeRow[] }>("/v1/staff-merges", { organizationId: activeOrganizationId })).merges });
  if (!q.isSuccess || q.data.length === 0) return null;
  async function undo(id: string) {
    setNote(null);
    if (reason.trim().length < 5) { setNote({ ok: false, text: "Give a reason (at least 5 characters)." }); return; }
    try {
      const r = await api.post<{ result: { state: string } }>(`/v1/staff-merges/${id}/undo`, { organizationId: activeOrganizationId, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
      setNote({ ok: true, text: r.result.state === "already_reversed" ? "That merge was already undone." : "Undone. The earlier values are back and the merged record is active again." });
      setTarget(null); setReason("");
      await queryClient.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("aws-") });
    } catch (cause) { setNote({ ok: false, text: message(cause, "Could not undo. Nothing was changed.") }); }
  }
  return (
    <details className="rounded-md border border-slate-200 bg-og-card px-3" data-testid="recent-merges">
      <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-og-ink md:min-h-[32px]">Recent merges ({q.data.length})</summary>
      <div className="space-y-2 pb-3 text-sm text-slate-800">
        <ul className="space-y-2">
          {q.data.map((m) => (
            <li key={m.linkId} className="rounded-md border border-slate-200 p-2" data-testid="merge-row">
              <p><span className="font-semibold">{m.mergedName}</span> merged into <span className="font-semibold">{m.keptName}</span> · {new Date(m.mergedAt).toLocaleDateString()}{m.mergedByName ? ` · ${m.mergedByName}` : ""}</p>
              <p className="text-og-sub">Reason: {m.reason}{m.reversedAt ? ` · Undone ${new Date(m.reversedAt).toLocaleDateString()}: ${m.reversedReason}` : ""}</p>
              {!m.reversedAt && !m.hasSnapshot ? <p className="text-og-sub">Made before undo was available.</p> : null}
              {!m.reversedAt && m.hasSnapshot && !m.canUndo ? <p className="text-og-sub">Cannot be undone now: one of the records changed after the merge.</p> : null}
              {m.canUndo ? (
                target === m.linkId ? (
                  <div className="mt-1 space-y-1">
                    <label className="block font-semibold text-og-ink">Reason for the undo<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-2" data-testid="undo-reason" /></label>
                    <div className="flex gap-2"><Button onClick={() => void undo(m.linkId)}>Undo this merge</Button><Button variant="secondary" onClick={() => { setTarget(null); setNote(null); }}>Cancel</Button></div>
                  </div>
                ) : <button type="button" className="mt-1 inline-flex min-h-[44px] items-center font-semibold underline md:min-h-[32px]" onClick={() => { setTarget(m.linkId); setNote(null); }}>Undo…</button>
              ) : null}
            </li>
          ))}
        </ul>
        {note ? <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-emerald-900" : "text-red-800"}>{note.text}</p> : null}
      </div>
    </details>
  );
}
