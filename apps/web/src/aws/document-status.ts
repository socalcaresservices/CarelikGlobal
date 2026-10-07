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

