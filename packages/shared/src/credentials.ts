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
export function getCredentialStatus(expiresAt: string | null, now: Date = new Date()): CredentialStatus {
  if (!expiresAt) return "no_expiration";
  const expiry = new Date(expiresAt).getTime();
  const nowTime = now.getTime();
  if (expiry < nowTime) return "expired";
  const daysUntilExpiry = (expiry - nowTime) / (24 * 60 * 60 * 1000);
  if (daysUntilExpiry <= EXPIRING_SOON_WINDOW_DAYS) return "expiring_soon";
  return "active";
}
