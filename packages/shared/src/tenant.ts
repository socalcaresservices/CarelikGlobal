import { z } from "zod";

export const organizationIdSchema = z.string().uuid();
export type OrganizationId = z.infer<typeof organizationIdSchema>;

// Branding fields are optional, not required-but-nullable, deliberately -
// they were added after the core five (Build 018) and most call sites
// that construct an Organization (tests, the onboarding wizard's success
// state) have no reason to know about them. Making them optional means
// organization-provider.tsx is the only place that needs to start
// supplying them; everywhere else keeps working unchanged. A caller that
// does have branding data can still pass an explicit `null` (column has
// no value set) or omit the key entirely (caller doesn't track it).
export const organizationSchema = z.object({
  id: organizationIdSchema,
  slug: z.string().min(2).max(63),
  legalName: z.string().min(2).max(200),
  displayName: z.string().min(2).max(120),
  status: z.enum(["active", "suspended", "closed"]),
  timezone: z.string().min(1),
  logoUrl: z.string().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  secondaryColor: z.string().nullable().optional(),
  accentColor: z.string().nullable().optional(),
  themeMode: z.enum(["light", "dark"]).optional(),
  showPoweredBy: z.boolean().optional()
});

export type Organization = z.infer<typeof organizationSchema>;
