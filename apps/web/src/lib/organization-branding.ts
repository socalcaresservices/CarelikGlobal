import { supabase } from "@/lib/supabase";

const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/**
 * Uploads an organization's logo to the public 'organization-branding'
 * storage bucket (20260727100000_organization_branding_bucket.sql) and
 * returns its public URL. Requires organization.update on
 * `organizationId` - enforced both here (a friendlier client-side error)
 * and, as the real gate, by the bucket's own RLS policies.
 *
 * Path convention: `<organizationId>/logo-<timestamp>.<ext>`, matching
 * the `<organization_id>/...` folder convention the storage policies key
 * their has_permission() check on (see storage.foldername(name))[1]).
 */
export async function uploadOrganizationLogo(organizationId: string, file: File): Promise<string> {
  if (!ALLOWED_LOGO_TYPES.has(file.type)) {
    throw new Error("Logo must be a PNG, JPEG, SVG, or WebP image.");
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new Error("Logo must be 5MB or smaller.");
  }

  const extension = file.name.split(".").pop()?.toLowerCase() || "png";
  const path = `${organizationId}/logo-${Date.now()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("organization-branding")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw new Error(uploadError.message);

  const { data } = supabase.storage.from("organization-branding").getPublicUrl(path);
  return data.publicUrl;
}
