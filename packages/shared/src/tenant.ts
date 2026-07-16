import { z } from "zod";

export const organizationIdSchema = z.string().uuid();
export type OrganizationId = z.infer<typeof organizationIdSchema>;

export const organizationSchema = z.object({
  id: organizationIdSchema,
  slug: z.string().min(2).max(63),
  legalName: z.string().min(2).max(200),
  displayName: z.string().min(2).max(120),
  status: z.enum(["active", "suspended", "closed"]),
  timezone: z.string().min(1)
});

export type Organization = z.infer<typeof organizationSchema>;
