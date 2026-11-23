import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Posting state of one shift, shown independently of who is assigned, with the action and what it will do before staff submits (0086). */
export function ShiftCoveragePanel({ shiftId, onClose, onDone }: { shiftId: string; onClose: () => void; onDone: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const status = useQuery({
    queryKey: ["aws-shift-coverage-status", activeOrganizationId, shiftId],
    queryFn: async () => (await api.get<{ status: { postingState: "not_posted" | "posted" | "unposted"; roundNo: number | null; requestCount: number; escalated: boolean } | null }>(`/v1/shifts/${encodeURIComponent(shiftId)}/coverage-status`, { organizationId: activeOrganizationId })).status,
    enabled: !!activeOrganizationId,
  });
  const posted = status.data?.postingState === "posted";
  async function act() {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/shifts/${encodeURIComponent(shiftId)}/${posted ? "unpost-coverage" : "post-coverage"}`, { organizationId: activeOrganizationId });
      await Promise.all(["aws-shift-coverage-status", "aws-coverage-queue", "aws-shifts"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onDone(posted ? "Taken off the board. Waiting requests were closed." : "Posted for coverage. Qualified caregivers for the service city can now request it.");
    } catch (cause) {
      setState({ busy: false, error: message(cause, "That did not work. Nothing changed.") });
    }
  }
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2 text-sm text-slate-800" data-testid="shift-coverage-panel">
      {status.isLoading ? <p className="text-slate-500">Loading…</p> : null}
      {status.isError ? <p role="alert" className="text-red-700">Posting status could not be loaded.</p> : null}
      {status.data !== undefined ? (
        <p data-testid="posting-state"><span className="font-semibold">Posting:</span> {posted ? "On the Open Shifts board" : status.data?.postingState === "unposted" ? "Taken off the board" : "Not posted"}
          {status.data && status.data.requestCount > 0 ? ` · ${status.data.requestCount} waiting ${status.data.requestCount === 1 ? "request" : "requests"}` : ""}</p>
      ) : null}
      <p className="text-slate-700">{posted
        ? "Unposting removes this shift from the board, closes any waiting requests and stops unsent texts. Nobody is unassigned."
        : "Posting shows this shift to caregivers approved for its service city and texts opted-in, eligible caregivers once it is inside the alert window. Posting does not assign anyone."}</p>
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" className="min-h-11" variant={posted ? "secondary" : "primary"} disabled={state.busy || status.isLoading} onClick={() => void act()}>{posted ? "Unpost" : "Post for Coverage"}</Button>
        <button type="button" className="text-sm underline" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
