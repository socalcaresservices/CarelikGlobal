// Staff document view model and plain-language status (0021).
import { formatDateOnly } from "@/lib/service-verification";
export interface StaffDocument {
  documentId: string;
  caregiverRecordId: string;
  personName: string;
  documentTypeId: string;
  documentTypeName: string;
  requiresExpiry: boolean;
  dueOn: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  latestContentType: string | null;
  latestUploadedAt: string | null;
  latestReviewStatus: "awaiting_review" | "verified" | "rejected" | null;
  latestRejectionReason: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  verifiedExpiresOn: string | null;
  displayStatus: "requested" | "overdue" | "awaiting_review" | "rejected" | "verified" | "expiring" | "expired";
  daysUntil: number | null;
  latestUploadedByMe?: boolean;
  /** 0033: review state and currency are separate; reviewer and review date of the latest reviewed version. */
  reviewState?: "requested" | "overdue" | "awaiting_review" | "verified" | "rejected";
  currencyStatus?: "current" | "expiring" | "expired" | "not_verified" | "no_expiry_required";
  reminderDays?: number[];
  reminderStage?: number | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
}
export interface DocumentType { documentTypeId: string; name: string; requiresExpiry: boolean; isActive: boolean; reminderDays?: number[]; usesAgencyDefault?: boolean }

export const REVIEW_STATE: Record<NonNullable<StaffDocument["reviewState"]>, { label: string; className: string }> = {
  requested: { label: "Requested", className: "bg-slate-100 text-slate-800" },
  overdue: { label: "Upload overdue", className: "bg-red-100 text-red-800" },
  awaiting_review: { label: "Awaiting review", className: "bg-sky-100 text-sky-900" },
  verified: { label: "Verified", className: "bg-emerald-100 text-emerald-900" },
  rejected: { label: "Rejected – upload again", className: "bg-amber-100 text-amber-900" },
};
export const CURRENCY_STATUS: Record<NonNullable<StaffDocument["currencyStatus"]>, { label: string; className: string } | null> = {
  current: { label: "Current", className: "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200" },
  expiring: { label: "Expiring", className: "bg-amber-100 text-amber-900" },
  expired: { label: "Expired", className: "bg-red-100 text-red-800" },
  not_verified: null,
  no_expiry_required: null,
};

/** "90, 60, 30" ⇄ [90, 60, 30]; null when the text is not 1–8 different whole numbers from 1 to 365. */
export function parseReminderDays(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 8 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const days = parts.map(Number);
  if (days.some((d) => d < 1 || d > 365) || new Set(days).size !== days.length) return null;
  return days.sort((a, b) => b - a);
}
export interface Person { caregiverRecordId: string; displayName: string; caregiverCode: string }

export const DOCUMENT_STATUS: Record<StaffDocument["displayStatus"], { label: string; className: string }> = {
  requested: { label: "Requested", className: "bg-slate-100 text-slate-800" },
  overdue: { label: "Overdue", className: "bg-red-100 text-red-800" },
  awaiting_review: { label: "Uploaded – awaiting review", className: "bg-sky-100 text-sky-900" },
  rejected: { label: "Rejected – upload again", className: "bg-amber-100 text-amber-900" },
  verified: { label: "Verified", className: "bg-emerald-100 text-emerald-900" },
  expiring: { label: "Expiring", className: "bg-amber-100 text-amber-900" },
  expired: { label: "Expired", className: "bg-red-100 text-red-800" },
};

const fmtDate = (iso: string) => formatDateOnly(iso);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Always the exact date plus days remaining/overdue (never a bare colour). */
export function documentDateLine(d: StaffDocument): string | null {
  const expiry = d.verifiedExpiresOn;
  if (expiry && d.daysUntil !== null) {
    if (d.daysUntil < 0) return `Expired ${fmtDate(expiry)} (${plural(-d.daysUntil, "day")} ago)`;
    if (d.daysUntil === 0) return `Expires today (${fmtDate(expiry)})`;
    return `Expires ${fmtDate(expiry)} (${plural(d.daysUntil, "day")} left)`;
  }
  if (d.dueOn && d.daysUntil !== null) {
    if (d.daysUntil < 0) return `Due ${fmtDate(d.dueOn)} (${plural(-d.daysUntil, "day")} overdue)`;
    if (d.daysUntil === 0) return `Due today (${fmtDate(d.dueOn)})`;
    return `Due ${fmtDate(d.dueOn)} (in ${plural(d.daysUntil, "day")})`;
  }
  return null;
}


export type DocumentFilter = "all" | "overdue" | "due_soon" | "to_review";

/** Blocking = the document is past its expiry or due date. These are the red items. */
export const isOverdue = (d: StaffDocument) => d.displayStatus === "overdue" || d.displayStatus === "expired";
/** Same definition as the server's "due soon" count (get_document_alerts.expiring): verified and inside the reminder window. */
export const isDueSoon = (d: StaffDocument) => d.displayStatus === "expiring";
export const isToReview = (d: StaffDocument) => d.displayStatus === "awaiting_review" || d.displayStatus === "rejected";

export function matchesFilter(d: StaffDocument, f: DocumentFilter): boolean {
  if (f === "overdue") return isOverdue(d);
  if (f === "due_soon") return isDueSoon(d);
  if (f === "to_review") return isToReview(d);
  return true;
}

/** The one short status shown on a card. The exact dates are in the details (documentDateLine). Tone: red = blocking, amber = approaching or needs a fix. */
export function documentStatusLabel(d: StaffDocument): { label: string; tone: "red" | "amber" | "neutral" } {
  const n = d.daysUntil;
  switch (d.displayStatus) {
    case "expired": return { label: n !== null && n < 0 ? `Expired ${plural(-n, "day")} ago` : "Expired", tone: "red" };
    case "overdue": return { label: n !== null && n < 0 ? `Overdue ${plural(-n, "day")}` : "Overdue", tone: "red" };
    case "expiring": return { label: n === null ? "Expiring soon" : n === 0 ? "Expires today" : `Expires in ${plural(n, "day")}`, tone: "amber" };
    case "rejected": return { label: "Rejected, replace", tone: "amber" };
    case "awaiting_review": return { label: "Awaiting review", tone: "neutral" };
    case "verified": return { label: "Current", tone: "neutral" };
    case "requested": return { label: n !== null && n >= 0 && d.dueOn ? (n === 0 ? "Requested, due today" : `Requested, due in ${plural(n, "day")}`) : "Requested", tone: "neutral" };
  }
}
