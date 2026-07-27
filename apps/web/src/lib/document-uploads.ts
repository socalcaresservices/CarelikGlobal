import { supabase } from "@/lib/supabase";
import { extractEdgeFunctionErrorMessage } from "@/lib/edge-function-errors";

export interface SubmitDocumentUploadInput {
  token: string;
  documentRequestId: string;
  file: File;
}

/**
 * The one write path on the public /upload/:token page. Backed by the
 * `submit-document-upload` edge function - the only place a document
 * actually lands in storage for an unauthenticated request, since there
 * is no anon-writable RLS policy on the organization-documents bucket
 * (see supabase/functions/submit-document-upload/index.ts for why that's
 * intentional). Uses FormData rather than JSON so the file travels as a
 * real multipart upload instead of a base64 string bloating the request.
 */
export async function submitDocumentUpload(input: SubmitDocumentUploadInput): Promise<void> {
  const body = new FormData();
  body.set("token", input.token);
  body.set("document_request_id", input.documentRequestId);
  body.set("file", input.file);

  const { error } = await supabase.functions.invoke("submit-document-upload", { body });

  if (error) {
    throw new Error(await extractEdgeFunctionErrorMessage(error, "Could not upload that file. Try again."));
  }
}
