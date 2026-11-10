// R6: people who appear more than once in Staff. A read-only report first; a merge only marks the extra staff profile inactive and linked (nothing is deleted),
// needs a reason, and is refused by the server unless the two records match and the extra one has no sign-in or invitation. SYNTHETIC data in tests only.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { ApiRequestError } from "../lib/aws-api";
import { useAwsApi } from "./aws-workspace";

type Dup = {
  groupId: string; matchBasis: "email" | "phone" | "name"; staffKey: string; source: string; profileId: string | null; displayName: string; staffTypeName: string | null;
  contactEmail: string | null; phone: string | null; accessStatus: string | null; canMerge: boolean;
};
const WHY: Record<Dup["matchBasis"], string> = { email: "Same email", phone: "Same phone number", name: "Same name" };
const SOURCE: Record<string, string> = { profile: "Staff profile", caregiver: "Caregiver (Care Team)", member: "Has a sign-in only" };

export function PossibleDuplicates() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [keep, setKeep] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["aws-staff-duplicates", activeOrganizationId],
    enabled: !!activeOrganizationId,
    retry: false,
    queryFn: async () => (await api.get<{ duplicates: Dup[] }>("/v1/staff/duplicates", { organizationId: activeOrganizationId })).duplicates,
  });
  // Not released in this environment (the route is not there): show nothing, and never an error for a feature that is simply off.
  if (q.isError && q.error instanceof ApiRequestError && q.error.status === 404) return null;
  if (q.isLoading) return null;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Possible duplicates could not be checked. They are not shown as none.</p>;
  const groups = new Map<string, Dup[]>();
  for (const d of q.data ?? []) groups.set(d.groupId, [...(groups.get(d.groupId) ?? []), d]);
  if (groups.size === 0 && !done) return null;

  const merge = async (members: Dup[], keepKey: string) => {
    const kept = members.find((m) => m.staffKey === keepKey);
    const others = members.filter((m) => m.staffKey !== keepKey && m.canMerge && m.profileId);
    if (!kept?.profileId || !kept.canMerge || others.length === 0) return;
    setBusy(true); setError(null);
    try {
      for (const o of others) await api.post(`/v1/staff/${kept.profileId}/merge`, { organizationId: activeOrganizationId, duplicateProfileId: o.profileId, reason });
      setDone(`Merged ${others.length} duplicate ${others.length === 1 ? "record" : "records"} into ${kept.displayName}. Nothing was deleted; the extra record is inactive.`);
      setKeep(null); setReason("");
      await queryClient.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith("aws-") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The merge did not complete.");
    } finally { setBusy(false); }
  };

  return (
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
                      <button type="button" className="inline-flex min-h-[44px] items-center font-semibold text-og-accent underline md:min-h-[32px]" onClick={() => { setKeep(m.staffKey); setError(null); setDone(null); }}>
                        Keep {m.displayName}, merge the others
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {keep && members.some((m) => m.staffKey === keep) ? (
                <form className="space-y-2 border-t border-slate-200 pt-2" onSubmit={(e) => { e.preventDefault(); void merge(members, keep); }}>
                  <label className="block font-semibold text-og-ink">Reason for the merge
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-2" />
                  </label>
                  {error ? <p role="alert" className="text-red-800">{error}</p> : null}
                  <div className="flex gap-2">
                    <Button type="submit" disabled={busy || reason.trim().length < 5}>{busy ? "Merging…" : "Merge"}</Button>
                    <Button type="button" variant="secondary" onClick={() => setKeep(null)}>Cancel</Button>
                  </div>
                </form>
              ) : null}
            </section>
          );
        })}
      </div>
    </details>
  );
}
