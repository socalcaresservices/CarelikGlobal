import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateTime, formatDuration } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

interface AuthReview {
  reviewId: string; reason: "authorization_over_cap" | "authorization_outside_period"; billableMinutes: number; excessMinutes: number; newMonthlyMinutes: number;
  openedAt: string; openedByName: string | null; resolvedAt: string | null; resolution: "confirmed_billable" | null; resolutionNote: string | null; resolvedByName: string | null;
}

/**
 * 0071: the authorization was lowered after this visit was confirmed and the visit was not yet approved, so it was sent back to review. Nothing about the visit or its minutes changed.
 * A person with visit-management permission confirms it is still billable (with a note), or corrects the visit. Every review stays on record.
 */
export function AuthorizationReviewCard({ visitId }: { visitId: string }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("visits.manage");
  const q = useQuery({
    queryKey: ["visit-authorization-review", visitId],
    queryFn: async () => (await api.get<{ review: { open: boolean; reviews: AuthReview[] } | null }>(`/v1/visits/${encodeURIComponent(visitId)}/authorization-review`, { organizationId: activeOrganizationId })).review,
    enabled: !!visitId && !!activeOrganizationId,
  });
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const data = q.data;
  if (!data || data.reviews.length === 0) return null;
  async function resolve() {
    if (state.busy) return;
    if (note.trim().length < 10) return setState({ busy: false, error: "Write what you checked, at least 10 characters." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/visits/${encodeURIComponent(visitId)}/authorization-review/resolve`, { organizationId: activeOrganizationId, note: note.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setNote("");
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved. Nothing changed." });
    } finally {
      await Promise.all(["visit-authorization-review", "visit-review", "billing-review", "attention-overview", "authorization-impacts"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    }
  }
  const open = data.reviews.find((r) => !r.resolvedAt);
  return (
    <Card className="space-y-2 p-4" data-testid="authorization-review">
      <h2 className="text-base font-semibold text-slate-950">{open ? "The authorization was lowered after this visit was confirmed" : "Authorization review (resolved)"}</h2>
      {data.reviews.map((r) => (
        <div key={r.reviewId} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
          <p>
            {r.reason === "authorization_outside_period"
              ? "The visit falls outside the new authorization period."
              : `The new monthly limit is ${formatDuration(r.newMonthlyMinutes)}; this visit's ${formatDuration(r.billableMinutes)} goes ${formatDuration(r.excessMinutes)} past it.`}
          </p>
          <p className="text-xs text-slate-600">Sent back to review {formatDateTime(r.openedAt)}{r.openedByName ? ` after a change by ${r.openedByName}` : ""}. The visit, its minutes and its signature were not changed.</p>
          {r.resolvedAt ? <p className="text-emerald-800">Confirmed still billable by {r.resolvedByName ?? "someone"} on {formatDateTime(r.resolvedAt)}: “{r.resolutionNote}”</p> : null}
        </div>
      ))}
      {open && canManage ? (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700">
            What did you check? (kept with the visit)
            <textarea value={note} rows={2} maxLength={1000} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
          </label>
          <Button type="button" className="min-h-11" loading={state.busy} disabled={state.busy} onClick={() => void resolve()}>Confirm it is still billable</Button>
          <p className="text-xs text-slate-600">If the minutes are wrong, use Correct visit instead: it keeps the original and links the corrected record. Billing approval is a separate step.</p>
        </div>
      ) : open ? <p className="text-sm text-slate-600">A person who manages visits has to review this before it can be approved.</p> : null}
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
    </Card>
  );
}
