// Attention by purpose (migration 0056). One read-only classification from the server, shown as four destinations:
//   Needs attention now | Upcoming staffing | Documents & compliance | Visit review
// "Now" means starting or running within 48 hours: owner decision D10 (the server's default window).
// Colour means one thing everywhere: red = care is blocked or at risk now; amber = risk is approaching; neutral = routine work.
// Colour is never the only signal: every tone has a word and a symbol (TONE below).
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export type Tone = "red" | "amber" | "neutral";
export const URGENT_WINDOW_HOURS = 48;

export interface UrgentItem {
  kind: "shift" | "visit";
  id: string;
  startsAt: string;
  endsAt: string | null;
  reasons: string[];
  severity: "red" | "amber";
  inProgress: boolean;
  caregiverRecordId: string | null;
  caregiverCode: string | null;
  clientCode: string | null;
  serviceCode: string | null;
}
export interface UpcomingShift { shiftId: string; startsAt: string; endsAt: string; reason: "open" | "called_out"; clientCode: string | null; serviceCode: string | null; serviceName: string | null }
export interface AttentionOverview {
  asOf: string;
  urgentWindowHours: number;
  urgent: { items: UrgentItem[]; itemCount: number; issueCount: number; shifts: number; visits: number } | null;
  upcoming: { count: number; nextStartsAt: string | null; shifts: UpcomingShift[] } | null;
  documents: { overdue?: number; dueSoon?: number; awaitingReview?: number; rejected?: number; caregiversOnHold?: number; caregiversWithPendingRequirements?: number } | null;
  visitReview: { visitsNeedingAttention: number; awaitingConfirmation: number; needsReview: number; lateResponses: number; readyForApproval: number | null; reviewIssues: number; awaitingResponse: number } | null;
}

export function useAttentionOverview() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("visits.read") || hasPermission("shifts.manage") || hasPermission("documents.read") || hasPermission("readiness.read");
  return useQuery({
    queryKey: ["attention-overview", activeOrganizationId],
    queryFn: async () => (await api.get<{ overview: AttentionOverview }>("/v1/attention/overview", { organizationId: activeOrganizationId })).overview,
    enabled: !!activeOrganizationId && allowed,
    refetchInterval: 5 * 60_000,
  });
}

/** Word + symbol + classes for a tone. Used by every row and tile so a status looks the same wherever it appears. */
export const TONE: Record<Tone, { word: string; icon: string; badge: string; text: string }> = {
  red: { word: "Urgent", icon: "●", badge: "bg-red-100 text-red-800", text: "text-red-700" },
  amber: { word: "Soon", icon: "▲", badge: "bg-amber-100 text-amber-900", text: "text-amber-800" },
  neutral: { word: "Routine", icon: "○", badge: "bg-slate-100 text-slate-700", text: "text-og-sub" },
};

export const REASON_LABEL: Record<string, string> = {
  uncovered_open: "No caregiver assigned",
  uncovered_called_out: "Caregiver called out, not replaced",
  compliance_hold: "Caregiver is on a compliance hold",
  documents_not_current: "A required document is not current",
  missing_clock_out: "Still open past the shift end",
  in_progress_on_hold: "Visit in progress for a caregiver on hold",
};

export interface Stream {
  key: "now" | "staffing" | "documents" | "visits";
  label: string;
  /** The number on the tile, or null when this viewer may not see the stream (never a false zero). */
  count: number | null;
  unit: string;
  to: string;
  tone: Tone;
  detail: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const HOURS_72 = 72 * 3_600_000;

/** The four streams, in the order people act on them. Pure: the same overview always gives the same tiles. */
export function streams(o: AttentionOverview, now = Date.parse(o.asOf)): Stream[] {
  const out: Stream[] = [];
  if (o.urgent) {
    const u = o.urgent;
    const tone: Tone = u.items.some((i) => i.severity === "red") ? "red" : u.itemCount > 0 ? "amber" : "neutral";
    out.push({
      key: "now", label: "Needs attention now", count: u.itemCount, unit: u.itemCount === 1 ? "item" : "items", to: "/attention", tone,
      detail: u.itemCount === 0 ? `Nothing starting in the next ${o.urgentWindowHours} hours is at risk.` : u.issueCount !== u.itemCount ? `${plural(u.issueCount, "issue")} across ${plural(u.itemCount, "item")}` : `Within ${o.urgentWindowHours} hours`,
    });
  }
  if (o.upcoming) {
    const u = o.upcoming;
    const soon = u.nextStartsAt !== null && Date.parse(u.nextStartsAt) - now <= HOURS_72;
    out.push({
      key: "staffing", label: "Upcoming staffing", count: u.count, unit: u.count === 1 ? "uncovered shift" : "uncovered shifts", to: "/staffing",
      tone: u.count > 0 && soon ? "amber" : "neutral",
      detail: u.count === 0 ? "Every shift after the next 48 hours has a caregiver." : "Later than the next 48 hours, soonest first",
    });
  }
  if (o.documents && (o.documents.overdue !== undefined || o.documents.caregiversOnHold !== undefined)) {
    const d = o.documents;
    const needs = (d.overdue ?? 0) + (d.rejected ?? 0) + (d.awaitingReview ?? 0) + (d.caregiversOnHold ?? 0);
    const bits = [d.overdue ? `${d.overdue} overdue` : null, d.caregiversOnHold ? `${plural(d.caregiversOnHold, "caregiver")} on hold` : null, d.dueSoon ? `${d.dueSoon} due soon` : null, d.caregiversWithPendingRequirements ? `${d.caregiversWithPendingRequirements} pending` : null].filter(Boolean);
    out.push({
      key: "documents", label: "Documents & compliance", count: needs, unit: needs === 1 ? "to act on" : "to act on", to: "/documents",
      tone: (d.overdue ?? 0) + (d.rejected ?? 0) + (d.caregiversOnHold ?? 0) > 0 ? "amber" : "neutral",
      detail: bits.length ? bits.join(" · ") : "Nothing overdue or due soon.",
    });
  }
  if (o.visitReview) {
    const v = o.visitReview;
    out.push({
      key: "visits", label: "Visit review", count: v.visitsNeedingAttention, unit: v.visitsNeedingAttention === 1 ? "visit" : "visits", to: "/visit-review", tone: "neutral",
      detail: v.visitsNeedingAttention === 0 ? "No visit is waiting for confirmation or approval." : "Waiting for confirmation or approval",
    });
  }
  return out;
}

export type UrgentBadge =
  | { kind: "hidden" }
  | { kind: "checking" | "unknown"; label: string; icon: string; count: null; aria: string; tone: "neutral" }
  | { kind: "urgent"; label: string; icon: string; count: number; aria: string; tone: Tone }
  | { kind: "clear"; label: string; icon: string; count: 0; aria: string; tone: "neutral" };

/**
 * The header badge. It counts only "Needs attention now" items (unique shifts and visits), never the sum of every list.
 * Red only when something is blocked or at risk now, amber when the risk is approaching, calm for a confirmed zero.
 * While loading or after a failed check it says so; it never shows a false zero.
 */
export function urgentBadge(loading: boolean, failed: boolean, o: AttentionOverview | null | undefined): UrgentBadge {
  if (loading) return { kind: "checking", label: "Checking…", icon: "…", count: null, aria: "Checking what needs attention now", tone: "neutral" };
  if (failed || !o) return { kind: "unknown", label: "Unable to check", icon: "?", count: null, aria: "Unable to check what needs attention now", tone: "neutral" };
  if (!o.urgent) return { kind: "hidden" };
  const n = o.urgent.itemCount;
  if (n === 0) return { kind: "clear", label: "Nothing urgent", icon: "✓", count: 0, aria: "Nothing needs attention now", tone: "neutral" };
  const tone: Tone = o.urgent.items.some((i) => i.severity === "red") ? "red" : "amber";
  return { kind: "urgent", label: "Needs attention now", icon: TONE[tone].icon, count: n, aria: `Needs attention now: ${n} ${n === 1 ? "item" : "items"}`, tone };
}
