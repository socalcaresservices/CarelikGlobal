import { z } from "zod";
import { organizationIdSchema } from "./tenant";

// Document Request Engine (Build 019). Status and subject-type are
// workflow/routing concepts, so those are enums; document type name and
// category stay free text (same reasoning as credentialType/payer/
// incident category elsewhere in this schema) since organizations
// invent their own document names beyond the seeded defaults.
export const documentRequestStatusSchema = z.enum([
  "requested",
  "uploaded",
  "pending_review",
  "verified",
  "rejected",
  "expired",
  "missing",
  "replacement_requested"
]);
export type DocumentRequestStatus = z.infer<typeof documentRequestStatusSchema>;

export const documentRequestSubjectTypeSchema = z.enum([
  "applicant",
  "employee",
  "contractor",
  "vendor",
  "organization_admin"
]);
export type DocumentRequestSubjectType = z.infer<typeof documentRequestSubjectTypeSchema>;

// organizationId is nullable - null means a platform-default document
// type (seeded once, available to every organization to request),
// non-null means an organization's own custom addition to the library.
export const documentTypeSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema.nullable(),
  name: z.string().min(1),
  category: z.string().nullable(),
  requiresExpiration: z.boolean(),
  isActive: z.boolean()
});
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const documentRequestBatchSchema = z.object({
  id: z.string().uuid(),
  organizationId: organizationIdSchema,
  subjectType: documentRequestSubjectTypeSchema,
  subjectId: z.string().uuid().nullable(),
  subjectName: z.string().min(1),
  subjectEmail: z.string().nullable(),
  token: z.string().min(1),
  message: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});
export type DocumentRequestBatch = z.infer<typeof documentRequestBatchSchema>;

export const documentRequestSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  documentTypeName: z.string().min(1),
  status: documentRequestStatusSchema,
  uploadedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  notes: z.string().nullable(),
  batchToken: z.string().min(1),
  batchCreatedAt: z.string()
});
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
