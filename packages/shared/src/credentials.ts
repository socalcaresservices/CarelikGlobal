import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// credentialType is free text, not an enum - see the migration comment in
// supabase/migrations/20260719250000_caregiver_credentials.sql for why:
// compliance requirements vary by state/agency and a fixed list would be
// guessing at business rules nobody has confirmed.
export const caregiverCredentialSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  caregiverUserId: z.string().uuid(),
  caregiverName: z.string(),
  credentialType: z.string().min(1),
  issuedDate: z.string().nullable(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable()
});

export type CaregiverCredential = z.infer<typeof caregiverCredentialSchema>;

export type CredentialStatus = "no_expiration" | "expired" | "expiring_soon" | "active";

const EXPIRING_SOON_WINDOW_DAYS = 30;

// Derived at read time rather than stored, so it never drifts out of date.
//
// expiresAt comes from a Postgres `date` column (caregiver_credentials.
// expires_at) and PostgREST serializes that as a bare "YYYY-MM-DD"
// string - it names a calendar date, not an instant. `new Date(expiresAt)`
// parses that as UTC midnight, so comparing its epoch millis directly
// against a real `now` instant made a credential read as "expired" up to
// a day before its actual expiration date for any viewer west of UTC
// (nearly every US timezone): a credential valid through August 15
// already showed "expired" starting August 14, 5pm PDT. Normalizing both
// sides to local calendar dates before comparing fixes that, and is
// harmless for callers still passing a full ISO timestamp (the ".slice(0,
// 10)" below just takes its date portion).
export function getCredentialStatus(expiresAt: string | null, now: Date = new Date()): CredentialStatus {
  if (!expiresAt) return "no_expiration";
  const [year, month, day] = expiresAt.slice(0, 10).split("-").map(Number);
  const expiry = new Date(year!, (month ?? 1) - 1, day ?? 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (expiry.getTime() < today.getTime()) return "expired";
  const daysUntilExpiry = (expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000);
  if (daysUntilExpiry <= EXPIRING_SOON_WINDOW_DAYS) return "expiring_soon";
  return "active";
}
