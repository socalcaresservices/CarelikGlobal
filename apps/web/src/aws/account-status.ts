// Plain-language sign-in account status (0048). The database decides the status; this only words it.
// Cognito's own terms (CONFIRMED, FORCE_CHANGE_PASSWORD, ...) are never shown.
export type AccountStatus = "active" | "invitation_pending" | "disabled" | "setup_required";

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  active: "Active",
  invitation_pending: "Invitation Pending",
  disabled: "Disabled",
  setup_required: "Account Setup Required",
};

export const ACCOUNT_STATUS_HELP: Record<AccountStatus, string> = {
  active: "Can sign in.",
  invitation_pending: "Invited; has not signed in yet. Must set a password at the first sign-in.",
  disabled: "Cannot sign in. Records, shifts and visit history are kept.",
  setup_required: "No sign-in yet. Send an invitation from Care Team.",
};

export const ACCOUNT_STATUS_BADGE: Record<AccountStatus, string> = {
  active: "bg-emerald-100 text-emerald-900",
  invitation_pending: "bg-amber-100 text-amber-900",
  disabled: "bg-slate-200 text-slate-800",
  setup_required: "bg-sky-100 text-sky-900",
};

const ROLE_LABEL: Record<string, string> = {
  organization_owner: "Administrator", organization_admin: "Administrator", manager: "Manager", scheduler: "Scheduler",
  coordinator: "Coordinator", staff: "Staff", caregiver: "Caregiver", read_only: "Read only",
};
export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

/** Anything the server sends that is not one of the four known statuses is shown as it is, never guessed. */
export const isAccountStatus = (value: string): value is AccountStatus => value in ACCOUNT_STATUS_LABEL;
