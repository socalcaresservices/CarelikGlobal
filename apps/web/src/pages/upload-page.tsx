import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, StatusBadge, type StatusTone } from "@carelik/ui";
import type { DocumentRequestStatus } from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { submitDocumentUpload } from "@/lib/document-uploads";

// Public, unauthenticated document upload page (Build 021) - the other
// half of the Document Request Engine begun in Build 019. Resolves the
// :token URL segment via two anon-callable RPCs
// (get_document_request_batch / list_document_requests_for_token) the
// same way apply-page.tsx resolves :orgSlug via get_organization_by_slug
// - no table is opened to anon, only these two narrow, token-scoped
// functions. Lives outside <ProtectedRoute> in App.tsx.
//
// White-labeled with the requesting organization's logo/display name/
// primary color pulled from the batch RPC, same branding fields
// app-shell.tsx already renders for signed-in users (Build 018).
//
// Upload itself goes through the submit-document-upload edge function
// (service-role only - see that function's own comment for why there's
// no anon-writable storage policy instead), one file per requested
// document type. A request already 'verified' shows as read-only; every
// other status still accepts a new upload, since 'rejected' is exactly
// the case where the applicant needs to try again.

interface BatchInfo {
  batch_id: string;
  organization_id: string;
  organization_display_name: string;
  organization_logo_url: string | null;
  organization_primary_color: string | null;
  organization_accent_color: string | null;
  organization_show_powered_by: boolean;
  subject_name: string;
  message: string | null;
  expires_at: string | null;
}

interface DocumentRow {
  id: string;
  document_type_name: string;
  category: string | null;
  requires_expiration: boolean;
  status: DocumentRequestStatus;
  uploaded_at: string | null;
  rejection_reason: string | null;
}

const REUPLOADABLE_STATUSES: DocumentRequestStatus[] = [
  "requested",
  "uploaded",
  "rejected",
  "replacement_requested",
  "expired",
  "missing"
];

const statusTone: Record<DocumentRequestStatus, StatusTone> = {
  requested: "info",
  uploaded: "warning",
  pending_review: "warning",
  verified: "success",
  rejected: "danger",
  expired: "danger",
  missing: "danger",
  replacement_requested: "warning"
};

function formatStatus(status: DocumentRequestStatus) {
  return status.replace(/_/g, " ");
}

function DocumentUploadRow({
  token,
  row,
  accentColor
}: {
  token: string;
  row: DocumentRow;
  accentColor: string;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canUpload = REUPLOADABLE_STATUSES.includes(row.status);

  async function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError(null);
    setUploading(true);
    try {
      await submitDocumentUpload({ token, documentRequestId: row.id, file });
      void queryClient.invalidateQueries({ queryKey: ["upload-documents", token] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">{row.document_type_name}</p>
          {row.uploaded_at ? (
            <p className="text-xs text-slate-400">Uploaded {new Date(row.uploaded_at).toLocaleDateString()}</p>
          ) : null}
        </div>
        <StatusBadge label={formatStatus(row.status)} tone={statusTone[row.status]} />
      </div>
      {row.status === "rejected" && row.rejection_reason ? (
        <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{row.rejection_reason}</p>
      ) : null}
      {canUpload ? (
        <div>
          <input ref={inputRef} type="file" onChange={(event) => void handleFileChosen(event)} className="hidden" />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-60"
            style={{ backgroundColor: accentColor }}
          >
            {uploading ? "Uploading…" : row.status === "requested" ? "Upload file" : "Upload a different file"}
          </button>
          {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function UploadPage() {
  const { token } = useParams<{ token: string }>();

  const batchQuery = useQuery({
    queryKey: ["upload-batch", token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_document_request_batch", { target_token: token! });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as BatchInfo | null;
    },
    enabled: !!token
  });

  const documentsQuery = useQuery({
    queryKey: ["upload-documents", token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_document_requests_for_token", { target_token: token! });
      if (error) throw error;
      return (data ?? []) as DocumentRow[];
    },
    enabled: !!token && !!batchQuery.data
  });

  if (!token || (!batchQuery.isLoading && !batchQuery.data)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold text-slate-950">Link not found</h1>
          <p className="mt-2 text-sm text-slate-600">
            This upload link isn&apos;t valid or has expired. Ask your contact for a new one.
          </p>
        </Card>
      </div>
    );
  }

  if (batchQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  const batch = batchQuery.data!;
  const documents = documentsQuery.data ?? [];
  const outstandingCount = documents.filter((row) => REUPLOADABLE_STATUSES.includes(row.status)).length;
  const accentColor = batch.organization_accent_color ?? batch.organization_primary_color ?? "#0f172a";

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          {batch.organization_logo_url ? (
            <img
              src={batch.organization_logo_url}
              alt={batch.organization_display_name}
              className="h-9 max-w-[160px] object-contain"
            />
          ) : (
            <p className="text-sm font-semibold text-slate-900">{batch.organization_display_name}</p>
          )}
        </div>

        <Card>
          <h1 className="text-lg font-semibold text-slate-950">Document request for {batch.subject_name}</h1>
          {batch.message ? <p className="mt-2 text-sm text-slate-600">{batch.message}</p> : null}
          <p className="mt-3 text-xs text-slate-500">
            {outstandingCount === 0
              ? "All requested documents have been uploaded. Thank you!"
              : `${outstandingCount} document${outstandingCount === 1 ? "" : "s"} still needed.`}
          </p>

          <div className="mt-4">
            {documentsQuery.isLoading ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : documents.length === 0 ? (
              <p className="text-sm text-slate-400">No documents were requested.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {documents.map((row) => (
                  <DocumentUploadRow key={row.id} token={token!} row={row} accentColor={accentColor} />
                ))}
              </ul>
            )}
          </div>
        </Card>

        {batch.organization_show_powered_by !== false ? (
          <p className="mt-4 text-center text-xs text-slate-400">Secured by CareLik</p>
        ) : null}
      </div>
    </div>
  );
}
