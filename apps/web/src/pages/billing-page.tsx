import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button, Card, PageHeader, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { formatHours, formatVisitDate } from "@/lib/service-verification";

// Reads/writes the pre-existing billing_approvals/billing_submissions
// pipeline (supabase/migrations/20260812193010 and 20260812193042) -
// this is the first UI to use it. Ready-to-bill visits (signed, no
// active approval yet) get approved one at a time with a $ amount
// computed from the visit's authorization rate, then approved-but-
// unsubmitted approvals get batched into a submission - the payer
// submission report / private-pay invoice equivalent.
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
  rate_cents: number | null;
  estimated_amount_cents: number | null;
}

interface ApprovalRow {
  approval_id: string;
  visit_id: string;
  client_name: string;
  service_name: string;
  service_date: string;
  approved_minutes: number;
  rate_cents: number | null;
  amount_cents: number | null;
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
  total_amount_cents: number;
}

interface SubmissionItemRow {
  item_id: string;
  visit_id: string;
  client_name: string;
  service_name: string;
  service_date: string;
  submitted_minutes: number;
  rate_cents: number | null;
  submitted_amount_cents: number | null;
  is_voided: boolean;
  void_reason: string | null;
}

function formatMoney(cents: number | null) {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function csvQuote(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const blob = new Blob(
    [[header, ...rows].map((row) => row.map(csvQuote).join(",")).join("\r\n")],
    {
      type: "text/csv;charset=utf-8",
    },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BillingPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("billing.visits.read");
  const canReadFinancial = hasPermission("billing.read");
  const canApprove = hasPermission("billing.approve");
  const canSubmit = canReadFinancial && hasPermission("billing.submit");

  const [approvingVisitId, setApprovingVisitId] = useState<string | null>(null);
  const [approveMinutes, setApproveMinutes] = useState("");
  const [approveNotes, setApproveNotes] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [selectedApprovalIds, setSelectedApprovalIds] = useState<Set<string>>(
    new Set(),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [expandedSubmissionId, setExpandedSubmissionId] = useState<
    string | null
  >(null);

  function invalidateAll() {
    void queryClient.invalidateQueries({
      queryKey: ["billing-ready-visits", activeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["billing-approvals", activeOrganizationId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["billing-submissions", activeOrganizationId],
    });
  }

  const readyQuery = useQuery({
    queryKey: ["billing-ready-visits", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_ready_visits", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return (data ?? []) as ReadyVisitRow[];
    },
    enabled: !!activeOrganizationId && canRead,
  });

  const approvalsQuery = useQuery({
    queryKey: ["billing-approvals", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_approvals", {
        target_organization_id: activeOrganizationId!,
        only_unsubmitted: false,
      });
      if (error) throw error;
      return (data ?? []) as ApprovalRow[];
    },
    enabled: !!activeOrganizationId && canRead,
  });

  const submissionsQuery = useQuery({
    queryKey: ["billing-submissions", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_billing_submissions", {
        target_organization_id: activeOrganizationId!,
      });
      if (error) throw error;
      return (data ?? []) as SubmissionRow[];
    },
    enabled: !!activeOrganizationId && canRead && canReadFinancial,
  });

  const submissionItemsQuery = useQuery({
    queryKey: ["billing-submission-items", expandedSubmissionId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "list_billing_submission_items",
        {
          target_submission_id: expandedSubmissionId!,
        },
      );
      if (error) throw error;
      return (data ?? []) as SubmissionItemRow[];
    },
    enabled: !!expandedSubmissionId && canReadFinancial,
  });

  function openApprove(row: ReadyVisitRow) {
    setApprovingVisitId(row.visit_id);
    setApproveMinutes(String(row.billable_minutes));
    setApproveNotes("");
    setApproveError(null);
  }

  function closeApprove() {
    setApprovingVisitId(null);
    setApproveError(null);
  }

  async function submitApproval(visitId: string) {
    setApproveError(null);
    const minutes = Number(approveMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      setApproveError("Approved minutes must be a non-negative number.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("approve_visit_for_billing", {
        target_visit_id: visitId,
        approved_minutes: minutes,
        notes: approveNotes.trim() || null,
      });
      if (error) throw error;
      closeApprove();
      invalidateAll();
    } catch (cause) {
      setApproveError(
        cause instanceof Error
          ? cause.message
          : "Could not approve this visit for billing.",
      );
    } finally {
      setSaving(false);
    }
  }

  function toggleApproval(id: string) {
    setSelectedApprovalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmitBatch() {
    setSubmitError(null);
    if (selectedApprovalIds.size === 0) {
      setSubmitError("Select at least one approval to submit.");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("submit_billing_approvals", {
        target_organization_id: activeOrganizationId!,
        approval_ids: Array.from(selectedApprovalIds),
      });
      if (error) throw error;
      setSelectedApprovalIds(new Set());
      invalidateAll();
    } catch (cause) {
      setSubmitError(
        cause instanceof Error
          ? cause.message
          : "Could not submit the selected approvals.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function exportSubmissionCsv(
    submission: SubmissionRow,
    items: SubmissionItemRow[],
  ) {
    const header = [
      "Client",
      "Service",
      "Date",
      "Minutes",
      "Rate",
      "Amount",
      "Status",
    ];
    const rows = items.map((item) => [
      item.client_name,
      item.service_name,
      item.service_date,
      item.submitted_minutes,
      item.rate_cents !== null ? (item.rate_cents / 100).toFixed(2) : "",
      item.submitted_amount_cents !== null
        ? (item.submitted_amount_cents / 100).toFixed(2)
        : "",
      item.is_voided ? `Voided: ${item.void_reason ?? ""}` : "Active",
    ]);
    downloadCsv(
      `billing-submission-${submission.submitted_at.slice(0, 10)}.csv`,
      header,
      rows,
    );
  }

  const unsubmittedApprovals = (approvalsQuery.data ?? []).filter(
    (row) => !row.is_voided && !row.is_submitted,
  );

  if (!canRead) {
    return (
      <section className="mx-auto max-w-5xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Billing</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">
            Not available
          </h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view billing for this
            organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow={canReadFinancial ? "Billing" : "Visit review"}
        title={
          canReadFinancial
            ? "Approve and submit visits for billing"
            : "Review and approve visit hours"
        }
        description={
          canReadFinancial
            ? "Turn signed visits into approved, dollar-valued billing batches - payer submission reports and private-pay invoices both start here."
            : "Review signed visits and approve service minutes. Rates, dollar amounts, and billing submissions are restricted to the owner."
        }
      />

      <Card>
        <h3 className="font-semibold text-slate-950">
          {canReadFinancial ? "Ready to bill" : "Ready for review"} (
          {readyQuery.data?.length ?? 0})
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {canReadFinancial
            ? "Signed visits with no active billing approval yet. The estimated amount uses the visit's authorization rate; approving lets you adjust the billed minutes before it is locked in."
            : "Signed visits awaiting an hours review. Approving lets you correct the service minutes before the owner prepares billing."}
        </p>
        {readyQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : readyQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">
            Could not load billing-ready visits.
          </p>
        ) : (readyQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            No signed visits are waiting to be billed.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-3 font-medium">Date</th>
                  <th className="pb-2 pr-3 font-medium">Client</th>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Caregiver</th>
                  <th className="pb-2 pr-3 font-medium">Billable</th>
                  {canReadFinancial ? (
                    <th className="pb-2 pr-3 font-medium">Rate</th>
                  ) : null}
                  {canReadFinancial ? (
                    <th className="pb-2 pr-3 font-medium">Est. amount</th>
                  ) : null}
                  {canApprove ? <th className="pb-2 font-medium" /> : null}
                </tr>
              </thead>
              <tbody>
                {(readyQuery.data ?? []).map((row) => (
                  <Fragment key={row.visit_id}>
                    <tr className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap text-slate-600">
                        {formatVisitDate(row.service_date)}
                      </td>
                      <td className="py-2 pr-3 text-slate-800">
                        {row.client_name}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        {row.service_name}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        {row.caregiver_name}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">
                        {formatHours(row.billable_minutes)}h
                      </td>
                      {canReadFinancial ? (
                        <td className="py-2 pr-3 text-slate-600">
                          {row.rate_cents !== null
                            ? `${formatMoney(row.rate_cents)}/hr`
                            : "No rate set"}
                        </td>
                      ) : null}
                      {canReadFinancial ? (
                        <td className="py-2 pr-3 font-medium text-slate-900">
                          {formatMoney(row.estimated_amount_cents)}
                        </td>
                      ) : null}
                      {canApprove ? (
                        <td className="py-2">
                          <button
                            type="button"
                            onClick={() => openApprove(row)}
                            className="text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
                          >
                            Approve
                          </button>
                        </td>
                      ) : null}
                    </tr>
                    {approvingVisitId === row.visit_id ? (
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <td
                          colSpan={
                            5 +
                            (canReadFinancial ? 2 : 0) +
                            (canApprove ? 1 : 0)
                          }
                          className="p-4"
                        >
                          <p className="text-sm font-semibold text-slate-900">
                            {canReadFinancial
                              ? "Approve for billing"
                              : "Approve visit hours"}
                          </p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <div>
                              <label
                                htmlFor="approve-minutes"
                                className="block text-xs font-medium text-slate-600"
                              >
                                Approved minutes
                              </label>
                              <input
                                id="approve-minutes"
                                type="number"
                                min={0}
                                max={row.worked_minutes}
                                value={approveMinutes}
                                onChange={(event) =>
                                  setApproveMinutes(event.target.value)
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label
                                htmlFor="approve-notes"
                                className="block text-xs font-medium text-slate-600"
                              >
                                Notes (optional)
                              </label>
                              <input
                                id="approve-notes"
                                value={approveNotes}
                                onChange={(event) =>
                                  setApproveNotes(event.target.value)
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                          </div>
                          {approveError ? (
                            <p className="mt-2 text-sm text-red-700">
                              {approveError}
                            </p>
                          ) : null}
                          <div className="mt-3 flex gap-3">
                            <Button
                              type="button"
                              loading={saving}
                              onClick={() => submitApproval(row.visit_id)}
                            >
                              {saving ? "Saving…" : "Confirm approval"}
                            </Button>
                            <button
                              type="button"
                              onClick={closeApprove}
                              className="text-sm font-medium text-slate-600 hover:text-slate-900"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-950">
              Approved, not yet submitted ({unsubmittedApprovals.length})
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {canSubmit
                ? "Select approvals and submit them together as one batch."
                : "The owner will prepare and submit billing after the visit hours are approved."}
            </p>
          </div>
          {canSubmit ? (
            <Button
              type="button"
              loading={submitting}
              disabled={selectedApprovalIds.size === 0}
              onClick={handleSubmitBatch}
            >
              {submitting
                ? "Submitting…"
                : `Submit selected (${selectedApprovalIds.size})`}
            </Button>
          ) : null}
        </div>
        {submitError ? (
          <p className="mt-2 text-sm text-red-700">{submitError}</p>
        ) : null}
        {approvalsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : approvalsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">
            Could not load billing approvals.
          </p>
        ) : unsubmittedApprovals.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            No approved visits are waiting to be submitted.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  {canSubmit ? <th className="pb-2 pr-3 font-medium" /> : null}
                  <th className="pb-2 pr-3 font-medium">Date</th>
                  <th className="pb-2 pr-3 font-medium">Client</th>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Minutes</th>
                  {canReadFinancial ? (
                    <th className="pb-2 pr-3 font-medium">Amount</th>
                  ) : null}
                  <th className="pb-2 pr-3 font-medium">Approved by</th>
                </tr>
              </thead>
              <tbody>
                {unsubmittedApprovals.map((row) => (
                  <tr
                    key={row.approval_id}
                    className="border-b border-slate-100 last:border-0"
                  >
                    {canSubmit ? (
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.client_name} ${row.service_date}`}
                          checked={selectedApprovalIds.has(row.approval_id)}
                          onChange={() => toggleApproval(row.approval_id)}
                        />
                      </td>
                    ) : null}
                    <td className="py-2 pr-3 whitespace-nowrap text-slate-600">
                      {formatVisitDate(row.service_date)}
                    </td>
                    <td className="py-2 pr-3 text-slate-800">
                      {row.client_name}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {row.service_name}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">
                      {formatHours(row.approved_minutes)}h
                    </td>
                    {canReadFinancial ? (
                      <td className="py-2 pr-3 font-medium text-slate-900">
                        {formatMoney(row.amount_cents)}
                      </td>
                    ) : null}
                    <td className="py-2 pr-3 text-slate-600">
                      {row.approved_by_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canReadFinancial ? (
        <Card>
          <h3 className="font-semibold text-slate-950">
            Submissions ({submissionsQuery.data?.length ?? 0})
          </h3>
          {submissionsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : submissionsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">
              Could not load billing submissions.
            </p>
          ) : (submissionsQuery.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No submissions yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {(submissionsQuery.data ?? []).map((submission) => (
                <li key={submission.submission_id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {formatVisitDate(submission.submitted_at)}
                        <span className="ml-2 text-slate-400">
                          by {submission.submitted_by_name}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {submission.active_item_count} of{" "}
                        {submission.item_count} items ·{" "}
                        {formatHours(submission.total_submitted_minutes)}h ·{" "}
                        {formatMoney(submission.total_amount_cents)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {submission.notes ? (
                        <StatusBadge label={submission.notes} tone="info" />
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSubmissionId(
                            expandedSubmissionId === submission.submission_id
                              ? null
                              : submission.submission_id,
                          )
                        }
                        className="text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
                      >
                        {expandedSubmissionId === submission.submission_id
                          ? "Hide"
                          : "View items"}
                      </button>
                    </div>
                  </div>
                  {expandedSubmissionId === submission.submission_id ? (
                    <div className="mt-3 rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                          Line items
                        </p>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            (submissionItemsQuery.data ?? []).length === 0
                          }
                          onClick={() =>
                            exportSubmissionCsv(
                              submission,
                              submissionItemsQuery.data ?? [],
                            )
                          }
                        >
                          <Download className="mr-1.5 h-4 w-4" /> Export CSV
                        </Button>
                      </div>
                      {submissionItemsQuery.isLoading ? (
                        <p className="mt-2 text-sm text-slate-500">Loading…</p>
                      ) : (
                        <ul className="mt-2 divide-y divide-slate-100">
                          {(submissionItemsQuery.data ?? []).map((item) => (
                            <li
                              key={item.item_id}
                              className="flex items-center justify-between py-1.5 text-sm"
                            >
                              <span className="text-slate-700">
                                {item.client_name} · {item.service_name} ·{" "}
                                {formatVisitDate(item.service_date)}
                              </span>
                              <span className="flex items-center gap-2">
                                {item.is_voided ? (
                                  <StatusBadge label="Voided" tone="neutral" />
                                ) : null}
                                <span className="font-medium text-slate-900">
                                  {formatHours(item.submitted_minutes)}h ·{" "}
                                  {formatMoney(item.submitted_amount_cents)}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </section>
  );
}
