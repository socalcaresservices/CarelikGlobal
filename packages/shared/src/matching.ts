import { z } from "zod";

// CareScore: a match/fit score between one client and one caregiver, per
// the user's own definition (not a general caregiver rating). See the
// migration comment in
// supabase/migrations/20260719280000_caregiver_client_matching.sql for
// the full weighting rationale - this schema just describes the shape
// list_caregiver_matches() returns.

export const caregiverLocationSchema = z.object({
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressZip: z.string().nullable(),
  languages: z.array(z.string()),
  skills: z.array(z.string())
});

export type CaregiverLocation = z.infer<typeof caregiverLocationSchema>;

export const clientLocationNeedsSchema = z.object({
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressZip: z.string().nullable(),
  languageNeeds: z.array(z.string()),
  careNeeds: z.array(z.string())
});

export type ClientLocationNeeds = z.infer<typeof clientLocationNeedsSchema>;

export const caregiverMatchSchema = z.object({
  caregiverUserId: z.string().uuid(),
  caregiverName: z.string(),
  matchScore: z.number().int().min(0).max(100),
  proximityScore: z.number().int().min(0).max(30),
  languageScore: z.number().int().min(0).max(25),
  availabilityScore: z.number().int().min(0).max(20),
  skillsScore: z.number().int().min(0).max(10),
  historyScore: z.number().int().min(0).max(15)
});

export type CaregiverMatch = z.infer<typeof caregiverMatchSchema>;
