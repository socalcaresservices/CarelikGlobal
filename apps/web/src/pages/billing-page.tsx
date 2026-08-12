import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, StatusBadge, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Billing Ready -> Billing Approved -> Submitted/Billed
// (20260812220000_billing_approval_pipeline.sql). "Ready" is a computed
// list (list_billing_ready_visits) - a signed visit with no active
// approval yet, never a stored status. "Approved" and "Submitted" are
// each the *existence* of an active row in billing_approvals /
// billing_submission_items - approving or submitting never touches the
// underlying service_visits row, so worked/verified/billable minutes on
// a signed visit stay exactly what they were signed as, no matter what
// happens to it afterward in this pipeline.
interface ReadyVisitRow {
  visit_id: string;
  client_id: string;
  client_name: string;
  service_name: string;
  caregiver_name: string;
  service_date: string;
  worked_minutes: number;
  billable_minutes: number;
  signed_at: string;
}

interface ApprovalRow {
  approval_id: string;
  visit_id: string;
  client_name: string;
  service_name: string;
  service_date: string;
  approved_minutes: number;
  approved_by_name: string;
  approved_at: string;
  is_voided: boolean;
  is_submitted: boolean;
}

interface SubmissionRow {
  submission_id: string;
  submitted_by_name: string;
  submitted_at: string;
  period_start: string | null;
  period_end: string | null;
  notes: string | null;
  item_count: number;
  active_item_count: number;
  total_submitted_minutes: number;
}

type Tab = "ready" | "approved" | "history";

const TAB_LABEL: Record<Tab, string> = {
  ready: "Ready for review",
  approved: "Approved",
  history: "Submission history"
};

function formatHours(minutes: number) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function BillingPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("billing.read");
  const canApprove = hasPermission("billing.approve");
  const canSubmit = hasPermission("billing.submit");

  const [tab, setTab] = useState<Tab>("ready");
  const [approvingVisitId, setApprovingVisitId] = useState<string | null>(null);
  const [approvedMinutesInput, setApprovedMinutesInput] = useState("");
  const [approveNotes, setApproveNotes] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const [selectedApprovalIds, setSelectedApprovalIds] = useState<Set<string>>(new Set());
  const [submitNotes, setSubmitNotes] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const readyQuery = useQuery({
    queryKey: ["billing-ready", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_ready_visits", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as ReadyVisitRow[];
    },
    enabled: !!activeOrganizationId && canRead && tab === "ready"
  });

  const approvedQuery = useQuery({
    queryKey: ["billing-approvals", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_approvals", {
        target_organization_id: activeOrganizationId!,
        only_unsubmitted: true
      });
      if (error) throw error;
      return (data ?? []) as ApprovalRow[];
    },
    enabled: !!activeOrganizationId && canRead && tab === "approved"
  });

  const submissionsQuery = useQuery({
    queryKey: ["billing-submissions", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_submissions", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as SubmissionRow[];
    },
    enabled: !!activeOrganizationId && canRead && tab === "history"
  });

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["billing-ready", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["billing-approvals", activeOrganizationId] });
    void queryClient.invalidateQueries({ queryKey: ["billing-submissions", activeOrganizationId] });
  }

  function startApprove(row: ReadyVisitRow) {
    setApprovingVisitId(row.visit_id);
    setApprovedMinutesInput(String(row.billable_minutes));
    setApproveNotes("");
    setApproveError(null);
  }

  async function handleApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approvingVisitId) return;
    const minutes = Number(approvedMinutesInput);
    if (!Number.isFinite(minutes) || minutes < 0) {
      setApproveError("Approved minutes must be a non-negative number.");
      return;
    }

    setApproving(true);
    setApproveError(null);
    try {
      const { error } = await supabase.rpc("approve_visit_for_billing", {
        target_visit_id: approvingVisitId,
        approved_minutes: Math.round(minutes),
        notes: approveNotes.trim() || null
      });
      if (error) throw error;
      setApprovingVisitId(null);
      refreshAll();
    } catch (cause) {
      setApproveError(cause instanceof Error ? cause.message : "Could not approve this visit for billing.");
    } finally {
      setApproving(false);
    }
  }

  function toggleSelected(approvalId: string) {
    setSelectedApprovalIds((prev) => {
      const next = new Set(prev);
      if (next.has(approvalId)) next.delete(approvalId);
      else next.add(approvalId);
      return next;
    });
  }

  async function handleSubmitBatch() {
    if (!activeOrganizationId || selectedApprovalIds.size === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { error } = await supabase.rpc("submit_billing_approvals", {
        target_organization_id: activeOrganizationId,
        approval_ids: Array.from(selectedApprovalIds),
        notes: submitNotes.trim() || null
      });
      if (error) throw error;
      setSelectedApprovalIds(new Set());
      setSubmitNotes("");
      refreshAll();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Could not submit the selected approvals.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Billing</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">You don&apos;t have permission to view billing for this organization.</p>
        </Card>
      </section>
    );
  }

  const readyRows = readyQuery.data ?? [];
  const approvedRows = approvedQuery.data ?? [];
  const submissionRows = submissionsQuery.data ?? [];

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-12">
      <div>
        <p className="text-sm font-medium text-slate-500">Billing</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Billing"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          A signed visit becomes billing-ready automatically. Nothing is submitted without an explicit human
          approval, and nothing already submitted can be silently changed.
        </p>
      </div>

      <div className="flex gap-2 border-b border-slate-200">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === key
                ? "border-b-2 border-slate-900 text-slate-950"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      {tab === "ready" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Ready for review</h3>
          <p className="mt-1 text-xs text-slate-500">Signed visits with no active billing approval yet.</p>
          {readyQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : readyQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load billing-ready visits.</p>
          ) : readyRows.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">Nothing waiting for review.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {readyRows.map((row) => (
                <li key={row.visit_id} className="py-3">
                  {approvingVisitId === row.visit_id ? (
                    <form onSubmit={handleApprove} className="space-y-3 rounded-lg bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p className="font-medium text-slate-900">
                          {row.client_name} · {row.service_name}
                        </p>
                        <p className="text-xs text-slate-500">{new Date(row.service_date).toLocaleDateString()}</p>
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label
                            htmlFor={`approve-minutes-${row.visit_id}`}
                            className="block text-xs font-medium text-slate-600"
                          >
                            Approved minutes
                          </label>
                          <input
                            id={`approve-minutes-${row.visit_id}`}
                            type="number"
                            min={0}
                            max={row.worked_minutes}
                            required
                            value={approvedMinutesInput}
                            onChange={(event) => setApprovedMinutesInput(event.target.value)}
                            className="mt-1 w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                          />
                        </div>
                        <div className="min-w-[220px] flex-1">
                          <label
                            htmlFor={`approve-notes-${row.visit_id}`}
                            className="block text-xs font-medium text-slate-600"
                          >
                            Notes (optional)
                          </label>
                          <input
                            id={`approve-notes-${row.visit_id}`}
                            value={approveNotes}
                            onChange={(event) => setApproveNotes(event.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                          />
                        </div>
                        <Button type="submit" size="sm" loading={approving}>
                          Approve
                        </Button>
                        <button
                          type="button"
                          onClick={() => setApprovingVisitId(null)}
                          className="text-sm font-medium text-slate-600 hover:text-slate-900"
                        >
                          Cancel
                        </button>
                      </div>
                      {approveError ? <p className="text-sm text-red-700">{approveError}</p> : null}
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {row.client_name} · {row.service_name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {new Date(row.service_date).toLocaleDateString()} · {row.caregiver_name} · Worked{" "}
                          {formatHours(row.worked_minutes)}h · Billable {formatHours(row.billable_minutes)}h
                        </p>
                      </div>
                      {canApprove ? (
                        <Button type="button" size="sm" variant="secondary" onClick={() => startApprove(row)}>
                          Review
                        </Button>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "approved" ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-950">Approved, not yet submitted</h3>
              <p className="mt-1 text-xs text-slate-500">Select approvals below, then submit them as one batch.</p>
            </div>
            {canSubmit && selectedApprovalIds.size > 0 ? (
              <div className="flex items-center gap-2">
                <input
                  value={submitNotes}
                  onChange={(event) => setSubmitNotes(event.target.value)}
                  placeholder="Batch notes (optional)"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                />
                <Button type="button" size="sm" loading={submitting} onClick={handleSubmitBatch}>
                  Submit {selectedApprovalIds.size} selected
                </Button>
              </div>
            ) : null}
          </div>
          {submitError ? <p className="mt-2 text-sm text-red-700">{submitError}</p> : null}
          {approvedQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : approvedQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load approved visits.</p>
          ) : approvedRows.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">Nothing approved and waiting to be submitted.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {approvedRows.map((row) => (
                <li key={row.approval_id} className="flex items-center gap-3 py-2.5">
                  {canSubmit ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.client_name} ${row.service_name}`}
                      checked={selectedApprovalIds.has(row.approval_id)}
                      onChange={() => toggleSelected(row.approval_id)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  ) : null}
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900">
                      {row.client_name} · {row.service_name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(row.service_date).toLocaleDateString()} · Approved{" "}
                      {formatHours(row.approved_minutes)}h by {row.approved_by_name}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Submission history</h3>
          <p className="mt-1 text-xs text-slate-500">
            Immutable record of what was submitted, when, and by whom. A correction after submission voids the
            item, it never rewrites this history.
          </p>
          {submissionsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : submissionsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load submission history.</p>
          ) : submissionRows.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">Nothing submitted yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {submissionRows.map((row) => {
                const hasVoided = row.active_item_count < row.item_count;
                const tone: StatusTone = hasVoided ? "warning" : "success";
                return (
                  <li key={row.submission_id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">
                        {row.active_item_count} of {row.item_count} visits · {formatHours(row.total_submitted_minutes)}h
                      </p>
                      <StatusBadge label={hasVoided ? "Includes voided items" : "Active"} tone={tone} />
                    </div>
                    <p className="text-xs text-slate-500">
                      {new Date(row.submitted_at).toLocaleString()} · {row.submitted_by_name}
                      {row.period_start && row.period_end
                        ? ` · ${new Date(row.period_start).toLocaleDateString()} – ${new Date(row.period_end).toLocaleDateString()}`
                        : ""}
                    </p>
                    {row.notes ? <p className="mt-1 text-xs text-slate-600">{row.notes}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}
    </section>
  );
}
