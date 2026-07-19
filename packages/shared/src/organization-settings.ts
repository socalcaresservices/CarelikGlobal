import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// public.organization_settings is a generic per-organization key/value
// store: (organization_id, key) is the primary key, value is arbitrary
// jsonb. This schema validates the shape of a single stored setting -
// it deliberately does not constrain `key` or `value` further, since
// the table's whole point is to hold settings nobody has defined a
// dedicated column for yet.
export const organizationSettingSchema = z.object({
  organizationId: organizationIdSchema,
  key: z.string().min(1).max(200),
  value: z.unknown(),
  version: z.number().int().positive(),
  updatedBy: z.string().uuid().nullable(),
  updatedAt: z.string()
});

export type OrganizationSetting = z.infer<typeof organizationSettingSchema>;
