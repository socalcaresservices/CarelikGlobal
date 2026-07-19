import { z } from "zod";
import { organizationIdSchema } from "./tenant";

export const clientStatusSchema = z.enum(["active", "inactive", "discharged"]);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const clientSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  careNotes: z.string().nullable(),
  status: clientStatusSchema
});

export type Client = z.infer<typeof clientSchema>;

export const shiftStatusSchema = z.enum(["scheduled", "completed", "cancelled", "no_show"]);
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

export const shiftSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: organizationIdSchema,
    clientId: z.string().uuid(),
    caregiverUserId: z.string().uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    status: shiftStatusSchema,
    notes: z.string().nullable()
  })
  .refine((shift) => new Date(shift.startsAt).getTime() < new Date(shift.endsAt).getTime(), {
    message: "startsAt must be before endsAt",
    path: ["endsAt"]
  });

export type Shift = z.infer<typeof shiftSchema>;
