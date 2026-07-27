// Supabase Edge Function: submit-document-upload
//
// The write half of the public /upload/:token page (Build 021). Has to
// run server-side because the caller is anonymous by design (a bearer
// token in a URL, not a signed-in user) and storage/files inserts need
// the service-role key to bypass RLS - there is no anon-writable storage
// policy on organization-documents, on purpose (see apply-page.tsx's own
// comment on why document upload wasn't built directly into that anon
// form). This function is the one deliberate, narrowly-scoped exception:
// everything it's allowed to touch is gated by proof of possession of an
// unguessable 32-byte token, not a permission check, since there is no
// caller identity to check a permission against.
//
// Request: multipart/form-data with fields:
//   token               - the document_request_batches.token bearer link
//   document_request_id - which requested document this upload answers
//   file                - the file itself
//
// Rejects: unknown/expired/deleted token, a document_request_id that
// doesn't belong to that batch, a request already 'verified' (re-upload
// only allowed while requested/uploaded/rejected/replacement_requested/
// expired/missing), files over 15MB, and mime types outside a small
// allowlist of what agencies actually ask for (PDF, images, common
// office docs).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const MAX_FILE_BYTES = 15 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

// Statuses a re-upload is allowed from. 'verified' and 'pending_review'
// are deliberately excluded - a verified document shouldn't be silently
// replaced from the public link, and pending_review (reserved for a
// future automated scan step) shouldn't be interrupted mid-flight.
const UPLOADABLE_STATUSES = new Set(["requested", "uploaded", "rejected", "replacement_requested", "expired", "missing"]);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function sanitizeFilename(name: string) {
  const trimmed = name.trim().slice(-120);
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "Request must be multipart/form-data" }, 400);
  }

  const token = form.get("token");
  const documentRequestId = form.get("document_request_id");
  const file = form.get("file");

  if (typeof token !== "string" || token.length === 0) {
    return jsonResponse({ error: "A valid link is required" }, 400);
  }
  if (typeof documentRequestId !== "string" || documentRequestId.length === 0) {
    return jsonResponse({ error: "document_request_id is required" }, 400);
  }
  if (!(file instanceof File)) {
    return jsonResponse({ error: "A file is required" }, 400);
  }
  if (file.size === 0) {
    return jsonResponse({ error: "That file is empty" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return jsonResponse({ error: "Files must be 15MB or smaller" }, 413);
  }
  if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
    return jsonResponse({ error: "That file type isn't accepted here. Try a PDF or image." }, 415);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  const { data: batch, error: batchError } = await adminClient
    .from("document_request_batches")
    .select("id, organization_id, expires_at, deleted_at")
    .eq("token", token)
    .maybeSingle();

  if (batchError) {
    return jsonResponse({ error: batchError.message }, 500);
  }
  if (!batch || batch.deleted_at || (batch.expires_at && new Date(batch.expires_at).getTime() <= Date.now())) {
    return jsonResponse({ error: "This link is invalid or has expired." }, 404);
  }

  const { data: request, error: requestError } = await adminClient
    .from("document_requests")
    .select("id, status, document_type_id, document_types(name)")
    .eq("id", documentRequestId)
    .eq("batch_id", batch.id)
    .maybeSingle();

  if (requestError) {
    return jsonResponse({ error: requestError.message }, 500);
  }
  if (!request) {
    return jsonResponse({ error: "That document isn't part of this request." }, 404);
  }
  if (!UPLOADABLE_STATUSES.has(request.status)) {
    return jsonResponse({ error: "This document has already been verified and can't be replaced here." }, 409);
  }

  const documentTypeName =
    (request.document_types as unknown as { name: string } | { name: string }[] | null) &&
    (Array.isArray(request.document_types) ? request.document_types[0]?.name : request.document_types?.name);

  const objectPath = `${batch.organization_id}/document-requests/${request.id}/${Date.now()}-${sanitizeFilename(file.name)}`;

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await adminClient.storage
    .from("organization-documents")
    .upload(objectPath, fileBytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false
    });

  if (uploadError) {
    return jsonResponse({ error: uploadError.message }, 500);
  }

  const { data: fileRow, error: fileInsertError } = await adminClient
    .from("files")
    .insert({
      organization_id: batch.organization_id,
      owner_type: "document_request",
      owner_id: request.id,
      document_type: documentTypeName ?? "Document",
      bucket_id: "organization-documents",
      object_path: objectPath,
      original_filename: file.name || "upload",
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      uploaded_by: null
    })
    .select("id")
    .single();

  if (fileInsertError || !fileRow) {
    await adminClient.storage.from("organization-documents").remove([objectPath]);
    return jsonResponse({ error: fileInsertError?.message ?? "Could not record the upload" }, 500);
  }

  const { error: updateError } = await adminClient
    .from("document_requests")
    .update({
      status: "uploaded",
      file_id: fileRow.id,
      uploaded_at: new Date().toISOString()
    })
    .eq("id", request.id);

  if (updateError) {
    return jsonResponse({ error: updateError.message }, 500);
  }

  return jsonResponse({ ok: true }, 200);
});
