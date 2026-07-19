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
  "incidents.read",
  "incidents.create",
  "incidents.update"
]);

export type Permission = z.infer<typeof permissionSchema>;

export const systemRoleSchema = z.enum([
  "platform_owner",
  "organization_owner",
  "organization_admin",
  "manager",
  "coordinator",
  "staff",
  "read_only"
]);

export type SystemRole = z.infer<typeof systemRoleSchema>;
