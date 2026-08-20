import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Button, Card, StatusBadge, type StatusTone } from "@carelik/ui";
import type { DocumentRequestStatus, DocumentRequestSubjectType } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

// Extracted out of the old applicant-detail-page.tsx (dead code - no
// route has referenced ApplicantDetailPage since CandidateDetailPage
// replaced it) into its own file so care-team-detail-page.tsx and
// candidate-detail-page.tsx can keep sharing it without keeping a
// ~900-line unrouted page component alive just to host this one
// component.
interface DocumentTypeOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface DocumentRequestRow {
  id: string;
  document_type_name: string;
  status: DocumentRequestStatus;
  uploaded_at: string | null;
  expires_at: string | null;
  rejection_reason: string | null;
  batch_token: string;
  batch_created_at: string;
  file_id: string | null;
  bucket_id: string | null;
  object_path: string | null;
  batch_reminders_sent: number;
  batch_last_reminder_sent_at: string | null;
}

// A staff member can act on an uploaded file once it's landed but hasn't
// been decided on yet. 'pending_review' is reserved for a future
// automated pre-check step (see the document_upload_workflow migration)
// but treated the same as 'uploaded' here since nothing currently
// produces that status.
const REVIEWABLE_STATUSES: DocumentRequestStatus[] = ["uploaded", "pending_review"];

// Same statuses queue_document_reminders() (20260728060000) actually
// sends reminders for - a verified or already-uploaded document isn't
// waiting on the subject anymore, so showing "2 reminders sent" next to
// it would be stale noise, not useful context. Reminder counts live on
// the batch, not the individual request, so every request in the same
// batch shows the same count - accurate (it's genuinely the batch's
// cadence), just not deduplicated across a multi-document batch. That's
// a deliberate simplification for this first pass rather than
// regrouping the whole list by batch.
const REMINDER_ELIGIBLE_STATUSES: DocumentRequestStatus[] = [
  "requested",
  "rejected",
  "replacement_requested",
  "missing"
];

const documentRequestStatusTone: Record<DocumentRequestStatus, StatusTone> = {
  requested: "info",
  uploaded: "warning",
  pending_review: "warning",
  verified: "success",
  rejected: "danger",
  expired: "danger",
  missing: "danger",
  replacement_requested: "warning"
};

function formatDocumentStatus(status: DocumentRequestStatus) {
  return status.replace(/_/g, " ");
}

export function DocumentsCard({
  organizationId,
  subjectType,
  subjectId,
  subjectName,
  subjectEmail,
  canRead,
  canManage
}: {
  organizationId: string | null | undefined;
  subjectType: DocumentRequestSubjectType;
  subjectId: string;
  subjectName: string;
  subjectEmail: string | null | undefined;
  canRead: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedTypeIds, setSelectedTypeIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const typesQuery = useQuery({
    queryKey: ["document-types", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_types")
        .select("id, name, is_active")
        .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as DocumentTypeOption[];
    },
    enabled: !!organizationId && canManage
  });

  const requestsQuery = useQuery({
    queryKey: ["document-requests-for-subject", organizationId, subjectId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_document_requests_for_subject", {
        target_organization_id: organizationId!,
        target_subject_id: subjectId
      });
      if (error) throw error;
      return (data ?? []) as DocumentRequestRow[];
    },
    enabled: !!organizationId && canRead
  });

  function toggleType(id: string) {
    setSelectedTypeIds((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  async function handleSend() {
    if (!organizationId || selectedTypeIds.length === 0) return;
    setSendError(null);
    setSending(true);
    setGeneratedLink(null);
    setCopied(false);
    try {
      const { data, error } = await supabase.rpc("create_document_request_batch", {
        target_organization_id: organizationId,
        target_subject_type: subjectType,
        target_subject_id: subjectId,
        target_subject_name: subjectName,
        target_subject_email: subjectEmail,
        target_document_type_ids: selectedTypeIds
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.token) {
        setGeneratedLink(`${window.location.origin}/upload/${row.token}`);
      }
      setSelectedTypeIds([]);
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Could not send document request.");
    } finally {
      setSending(false);
    }
  }

  function handleCopyLink() {
    if (!generatedLink) return;
    // Unlike handleSend/handleView/handleVerify/handleReject below, this
    // previously had no failure handling at all - writeText() rejects when
    // clipboard permission is denied or the tab isn't focused/secure, which
    // showed up as an unhandled promise rejection and a button that just
    // silently never flipped to "Copied".
    void navigator.clipboard
      .writeText(generatedLink)
      .then(() => setCopied(true))
      .catch(() => setSendError("Could not copy the link. Copy it manually instead."));
  }

  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function handleView(row: DocumentRequestRow) {
    if (!row.bucket_id || !row.object_path) return;
    setViewError(null);
    setViewingId(row.id);
    try {
      const { data, error } = await supabase.storage.from(row.bucket_id).createSignedUrl(row.object_path, 300);
      if (error) throw error;
      if (data?.signedUrl) {
        window.open(data.signedUrl, "_blank", "noopener,noreferrer");
      }
    } catch (cause) {
      setViewError(cause instanceof Error ? cause.message : "Could not open that file.");
    } finally {
      setViewingId(null);
    }
  }

  async function handleVerify(row: DocumentRequestRow) {
    if (!organizationId) return;
    setDecisionError(null);
    setDecidingId(row.id);
    try {
      const { error } = await supabase.rpc("verify_document_request", {
        target_organization_id: organizationId,
        target_document_request_id: row.id
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : "Could not verify that document.");
    } finally {
      setDecidingId(null);
    }
  }

  async function handleReject(row: DocumentRequestRow) {
    if (!organizationId) return;
    const reason = window.prompt("Why is this document being rejected?");
    if (!reason || !reason.trim()) return;
    setDecisionError(null);
    setDecidingId(row.id);
    try {
      const { error } = await supabase.rpc("reject_document_request", {
        target_organization_id: organizationId,
        target_document_request_id: row.id,
        reason: reason.trim()
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["document-requests-for-subject", organizationId, subjectId] });
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : "Could not reject that document.");
    } finally {
      setDecidingId(null);
    }
  }

  if (!canRead) return null;

  const activeTypes = (typesQuery.data ?? []).filter((type) => type.is_active);
  const requests = requestsQuery.data ?? [];

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Documents</h3>

      {canManage ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-slate-600">Request documents</p>
          {typesQuery.isLoading ? (
            <p className="mt-2 text-sm text-slate-500">Loading document types…</p>
          ) : typesQuery.isError ? (
            <p className="mt-2 text-sm text-red-700">Could not load document types.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {activeTypes.map((type) => (
                <label key={type.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedTypeIds.includes(type.id)}
                    onChange={() => toggleType(type.id)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {type.name}
                </label>
              ))}
            </div>
          )}
          <div className="mt-3">
            <Button disabled={selectedTypeIds.length === 0 || sending} loading={sending} onClick={handleSend}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
          {sendError ? <p className="mt-2 text-sm text-red-700">{sendError}</p> : null}
          {generatedLink ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
              <p className="flex-1 break-all text-xs text-emerald-800">{generatedLink}</p>
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex items-center gap-1 text-xs font-medium text-emerald-800 hover:underline"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        {requestsQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : requestsQuery.isError ? (
          <p className="text-sm text-red-700">Could not load document requests.</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-slate-400">No documents requested yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {requests.map((row) => {
              const isReviewable = canManage && REVIEWABLE_STATUSES.includes(row.status);
              const canView = !!row.bucket_id && !!row.object_path;
              const isBusy = decidingId === row.id || viewingId === row.id;
              return (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-800">{row.document_type_name}</span>
                    <div className="flex items-center gap-2">
                      {canView ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleView(row)}
                          className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline disabled:opacity-60"
                        >
                          {viewingId === row.id ? "Opening…" : "View"}
                        </button>
                      ) : null}
                      {isReviewable ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleVerify(row)}
                            className="text-xs font-medium text-emerald-700 underline-offset-2 hover:underline disabled:opacity-60"
                          >
                            Verify
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleReject(row)}
                            className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:opacity-60"
                          >
                            Reject
                          </button>
                        </>
                      ) : null}
                      <StatusBadge
                        label={formatDocumentStatus(row.status)}
                        tone={documentRequestStatusTone[row.status]}
                      />
                    </div>
                  </div>
                  {row.status === "rejected" && row.rejection_reason ? (
                    <p className="mt-1 text-xs text-red-700">{row.rejection_reason}</p>
                  ) : null}
                  {REMINDER_ELIGIBLE_STATUSES.includes(row.status) && row.batch_reminders_sent > 0 ? (
                    <p className="mt-1 text-xs text-slate-400">
                      {row.batch_reminders_sent} reminder{row.batch_reminders_sent === 1 ? "" : "s"} sent
                      {row.batch_last_reminder_sent_at
                        ? ` · last on ${new Date(row.batch_last_reminder_sent_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {viewError ? <p className="mt-2 text-xs text-red-700">{viewError}</p> : null}
        {decisionError ? <p className="mt-2 text-xs text-red-700">{decisionError}</p> : null}
      </div>
    </Card>
  );
}
