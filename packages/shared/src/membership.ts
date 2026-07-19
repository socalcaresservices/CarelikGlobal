import { z } from "zod";
import { organizationIdSchema } from "./tenant";
import { systemRoleSchema } from "./permissions";

export const membershipStatusSchema = z.enum(["invited", "active", "suspended", "revoked"]);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const organizationMembershipSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  userId: z.string().uuid(),
  role: systemRoleSchema,
  status: membershipStatusSchema
});

export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;
