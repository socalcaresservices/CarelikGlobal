// Labels and types for missing-signature recovery (0036). Kept out of the
// component files so they can be shared and unit-tested.
export type RecipientRole = "client" | "parent" | "guardian" | "authorized_representative";

export const RECOVERY_ROLE_LABEL: Record<string, string> = {
  client: "Client",
  parent: "Parent",
  guardian: "Guardian",
  authorized_representative: "Authorized representative",
};

export const REQUEST_STATE_LABEL: Record<string, string> = {
  open: "Waiting for response",
  answered: "Response received",
  expired: "Expired",
  locked: "Locked (too many wrong codes)",
  revoked: "Closed",
  void: "No longer valid (visit changed)",
};

export interface ConfirmationRequestRow {
  requestId: string;
  channel: "link" | "paper";
  recipientName: string;
  recipientRole: RecipientRole;
  identityCheck: string | null;
  state: "open" | "answered" | "expired" | "locked" | "revoked" | "void";
  failedCodeAttempts: number;
  expiresAt: string;
  createdByName: string | null;
  createdAt: string;
  revokedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  lateConfirmationId: string | null;
  outcome: "confirmed" | "disputed" | null;
  method: "draw" | "typed" | "paper" | null;
  signerName: string | null;
  signerRole: string | null;
  disputeReason: string | null;
  signedOn: string | null;
  receivedAt: string | null;
  recordedByName: string | null;
  hasEvidence: boolean;
  evidenceContentType: string | null;
  reviewOutcome: "accepted" | "rejected" | null;
  reviewReason: string | null;
  acceptedMinutes: number | null;
  cappedByAuthorization: boolean | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

/** The recipient link. The token travels in the URL fragment, which browsers never send to the web server. */
export const confirmVisitLink = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/confirm-visit#${token}`;
