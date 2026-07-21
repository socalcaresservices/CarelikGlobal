import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// The agency's own catalog of billable service types ("Personal care",
// "Companionship", "Skilled nursing"...), org-scoped. Exists so a client
// can hold more than one authorization at once without the two being
// confused for monthly-usage purposes - see client_authorizations in
// ./authorizations.ts, which references a service by id.
export const serviceSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  name: z.string().min(1),
  isActive: z.boolean()
});

export type Service = z.infer<typeof serviceSchema>;
