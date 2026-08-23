import { z } from "zod";

export const permissionSchema = z.enum([
  "organization.read",
  "organization.update",
  "membership.read",
  "membership.invite",
  "membership.update",
  "membership.remove",
  "settings.read",
  "settings.update",
  "audit.read",
  "files.read",
  "files.create",
  "files.delete",
  "clients.read",
  "clients.update",
  "shifts.read",
  "shifts.update",
  "credentials.read",
  "credentials.update",
  "authorizations.read",
  "authorizations.update",
  "services.read",
  "services.update",
  "incidents.read",
  "incidents.create",
  "incidents.update",
  "applicants.read",
  "applicants.update",
  "skills.read",
  "skills.update",
  "languages.read",
  "languages.update",
  "documents.read",
  "documents.manage",
  "visits.read",
  "visits.manage",
  "assignments.read",
  "assignments.update",
  "billing.read",
  "billing.update",
  "billing.visits.read",
  "billing.approve",
  "billing.submit"
]);

export type Permission = z.infer<typeof permissionSchema>;

export const systemRoleSchema = z.enum([
  "platform_owner",
  "organization_owner",
  "organization_admin",
  "manager",
  "scheduler",
  "coordinator",
  "staff",
  "caregiver",
  "read_only"
]);

export type SystemRole = z.infer<typeof systemRoleSchema>;
