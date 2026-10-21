// Attention by purpose (migration 0056). One read-only classification from the server, shown as four destinations:
//   Needs attention now | Upcoming staffing | Documents & compliance | Visit review
// "Now" means starting or running within 48 hours: owner decision D10 (the server's default window).
// One vocabulary everywhere (Board 4 D7/D8): Critical (red) = care is blocked or at risk now; Urgent (amber) = risk within the window;
// Routine (neutral) = ordinary work. Shifts that are uncovered but more than 48 hours away are "Upcoming staffing", not urgent.
// Colour is never the only signal: every tone has a word and a symbol (TONE below).
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export type Tone = "red" | "amber" | "neutral";
export const URGENT_WINDOW_HOURS = 48;
/** The overview is re-read this often; anything older than twice this is shown as possibly out of date. */
export const REFRESH_MS = 5 * 60_000;

export interface UrgentItem {
  kind: "shift" | "visit";
  id: string;
  startsAt: string;
  endsAt: string | null;
  reasons: string[];
  /** The server's tier (migration 0058). Older servers omit it; then `severity` is used (red = critical, amber = urgent). */
  tier?: "critical" | "urgent";
  severity: "red" | "amber";
  inProgress: boolean;
  caregiverRecordId: string | null;
  caregiverCode: string | null;
  clientCode: string | null;
  /** Added by the API for roles that may see client names (route layer); the code stays. */
  clientName?: string | null;
  duplicateName?: boolean;
  serviceCode: string | null;
}
export interface UpcomingShift { shiftId: string; startsAt: string; endsAt: string; reason: "open" | "called_out" | "compliance_hold" | "documents_not_current"; clientCode: string | null; clientName?: string | null; duplicateName?: boolean; serviceCode: string | null; serviceName: string | null }
export interface AttentionOverview {
  asOf: string;
  urgentWindowHours: number;
  urgent: { items: UrgentItem[]; itemCount: number; issueCount: number; shifts: number; visits: number; critical?: number; urgent?: number } | null;
  upcoming: { count: number; nextStartsAt: string | null; shifts: UpcomingShift[] } | null;
  /** reviewRoutine = awaiting review inside the deadline; reviewOverdue = escalated (48 h after upload, expired, or blocking care). */
  documents: { overdue?: number; dueSoon?: number; awaitingReview?: number; reviewRoutine?: number; reviewOverdue?: number; rejected?: number; caregiversOnHold?: number; caregiversWithPendingRequirements?: number } | null;
  /** visitsNeedingAttention = needsReview + lateResponses + confirmationOverdue. pendingConfirmation and readyForApproval are routine and never added to it. */
  /** 0063: caregivers' requests for open shifts waiting for an administrator. Routine; never added to the urgent total. Null without shifts.manage. */
  pickups?: { count: number; oldestRequestedAt: string | null } | null;
  /** 0067: shifts that ended with no visit record and still hold authorization time; nothing is released until a person decides. Null without shifts.manage. */
  reconciliation?: { count: number; minutes: number; oldestEndedAt: string | null } | null;
  /** 0068: reserved shifts and visits that an authorization amendment affected and nobody has acknowledged. */
  amendmentImpacts?: { count: number; oldestAt: string | null } | null;
  visitReview: { visitsNeedingAttention: number; pendingConfirmation?: number; confirmationOverdue?: number; awaitingConfirmation: number; needsReview: number; reviewOverdue?: number; lateResponses: number; readyForApproval: number | null; reviewIssues: number; awaitingResponse: number } | null;
}

export function useAttentionOverview() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("visits.read") || hasPermission("shifts.manage") || hasPermission("documents.read") || hasPermission("readiness.read");
  return useQuery({
    queryKey: ["attention-overview", activeOrganizationId],
    queryFn: async () => (await api.get<{ overview: AttentionOverview }>("/v1/attention/overview", { organizationId: activeOrganizationId })).overview,
    enabled: !!activeOrganizationId && allowed,
    refetchInterval: REFRESH_MS,
  });
}

/** Word + symbol + classes for a tone. Used by every row and tile so a status looks the same wherever it appears. */
export const TONE: Record<Tone, { word: string; icon: string; badge: string; text: string }> = {
  red: { word: "Critical", icon: "●", badge: "bg-red-100 text-red-800", text: "text-red-700" },
  amber: { word: "Urgent", icon: "▲", badge: "bg-amber-100 text-amber-900", text: "text-amber-800" },
  neutral: { word: "Routine", icon: "○", badge: "bg-slate-100 text-slate-700", text: "text-og-sub" },
};

export const REASON_LABEL: Record<string, string> = {
  uncovered_open: "No caregiver assigned",
  uncovered_called_out: "Caregiver called out, not replaced",
  called_out: "Caregiver called out, not replaced",
  open: "No caregiver assigned",
  compliance_hold: "Caregiver is on a compliance hold",
  documents_not_current: "A required document is not current",
  missing_clock_out: "Still open past the shift end",
  in_progress_on_hold: "Visit in progress for a caregiver on hold",
  over_limit: "Over the monthly authorization",
};

export interface Stream {
  key: "now" | "staffing" | "documents" | "visits";
  label: string;
  /** The number on the tile, or null when this viewer may not see the stream (never a false zero). */
  count: number | null;
  unit: string;
  to: string;
  tone: Tone;
  /** A chip word of its own where Critical / Urgent would claim too much (for example Overdue). Defaults to the tone's word. */
  word?: string | undefined;
  detail: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const UNCOVERED_REASONS = new Set(["uncovered_open", "uncovered_called_out"]);

/**
 * Severity of a start time for a shift nobody is covering: Critical once it has started, Urgent before that (the server only
 * returns shifts inside the 48-hour window; later ones are Upcoming staffing). `now` is the server's own `asOf`, never the browser clock.
 */
export function coverageTone(startsAt: string, now: number): Tone {
  return Date.parse(startsAt) <= now ? "red" : "amber";
}

/**
 * The tone of one Needs-attention item: the server's tier (red = Critical, amber = Urgent). For a response without a tier (an older server)
 * a shift whose only problem is "no caregiver" follows coverageTone and anything else keeps the old severity.
 */
export function itemTone(item: UrgentItem, now: number): Tone {
  if (item.tier) return item.tier === "critical" ? "red" : "amber"; // the server's answer (0058)
  if (item.kind === "shift" && item.reasons.length > 0 && item.reasons.every((r) => UNCOVERED_REASONS.has(r))) return coverageTone(item.startsAt, now);
  return item.severity;
}

/** Critical first, then Urgent; within a tier the soonest start first (a deterministic order for equal start times). */
export function rankedItems(items: UrgentItem[], now: number): UrgentItem[] {
  const rank = (i: UrgentItem) => (itemTone(i, now) === "red" ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How current the figures are. The time is the server's `asOf`; "stale" also covers a refresh that failed while older data is still shown. */
export const STALE_AFTER_MS = 2 * REFRESH_MS;
export type Freshness = { kind: "fresh"; asOf: string } | { kind: "stale"; asOf: string; reason: "old" | "refresh_failed" } | { kind: "unavailable" } | { kind: "loading" };
export function freshness(loading: boolean, failed: boolean, o: AttentionOverview | null | undefined, now: number): Freshness {
  if (!o) return loading ? { kind: "loading" } : { kind: "unavailable" };
  if (failed) return { kind: "stale", asOf: o.asOf, reason: "refresh_failed" };
  if (now - Date.parse(o.asOf) > STALE_AFTER_MS) return { kind: "stale", asOf: o.asOf, reason: "old" };
  return { kind: "fresh", asOf: o.asOf };
}

/** The four streams, in the order people act on them. Pure: the same overview always gives the same tiles. */
export function streams(o: AttentionOverview, now = Date.parse(o.asOf)): Stream[] {
  const out: Stream[] = [];
  if (o.urgent) {
    const u = o.urgent;
    const tone: Tone = u.items.some((i) => itemTone(i, now) === "red") ? "red" : u.itemCount > 0 ? "amber" : "neutral";
    out.push({
      key: "now", label: "Needs attention now", count: u.itemCount, unit: u.itemCount === 1 ? "item" : "items", to: "/attention", tone,
      detail: u.itemCount === 0 ? `Nothing starting in the next ${o.urgentWindowHours} hours is at risk.` : u.issueCount !== u.itemCount ? `${plural(u.issueCount, "issue")} in all` : `Within ${o.urgentWindowHours} hours`,
    });
  }
  if (o.upcoming) {
    const u = o.upcoming;
    out.push({
      key: "staffing", label: "Upcoming staffing", count: u.count, unit: u.count === 1 ? "shift" : "shifts", to: "/staffing",
      tone: "neutral",
      detail: u.count === 0 ? `Every shift more than ${o.urgentWindowHours} hours away has a caregiver who may work it.` : `Uncovered or blocked, more than ${o.urgentWindowHours} hours away, soonest first`,
    });
  }
  if (o.documents && (o.documents.overdue !== undefined || o.documents.caregiversOnHold !== undefined)) {
    const d = o.documents;
    // Routine review (inside its deadline) is shown but never counted. Escalated review (48 h, expired, or blocking care) is counted.
    const escalated = d.reviewOverdue ?? 0;
    const routine = d.reviewRoutine ?? (d.reviewOverdue === undefined ? (d.awaitingReview ?? 0) : Math.max((d.awaitingReview ?? 0) - escalated, 0));
    const needs = (d.overdue ?? 0) + (d.rejected ?? 0) + escalated + (d.caregiversOnHold ?? 0);
    // The count is the first group only; reminders and routine review are shown after it and never counted.
    const counted = [
      d.overdue ? `${d.overdue} overdue` : null,
      d.rejected ? `${d.rejected} rejected` : null,
      escalated ? `${escalated} review overdue` : null,
      d.caregiversOnHold ? `${plural(d.caregiversOnHold, "caregiver")} on hold` : null,
    ].filter(Boolean) as string[];
    const reminders = [
      routine ? `${routine} awaiting routine review` : null,
      d.dueSoon ? `${d.dueSoon} due soon` : null,
      d.caregiversWithPendingRequirements ? `${d.caregiversWithPendingRequirements} with requirements coming due` : null,
    ].filter(Boolean) as string[];
    const bits = [counted.join(" · "), reminders.length ? `Not counted: ${reminders.join(", ")}` : ""].filter(Boolean);
    out.push({
      key: "documents", label: "Documents & compliance", count: needs, unit: "to act on", to: "/documents",
      tone: needs > 0 ? "amber" : "neutral",
      word: (d.overdue ?? 0) + escalated > 0 ? "Overdue" : needs > 0 ? "Needs action" : undefined,
      detail: bits.length ? bits.join(" · ") : "Nothing overdue or due soon.",
    });
  }
  if (o.visitReview) {
    const v = o.visitReview;
    const pending = v.pendingConfirmation ?? 0;
    const ready = v.readyForApproval ?? 0;
    // What needs a person is the count. Pending Confirmation and Ready for Approval are routine: listed in the detail, never added.
    const routine = [pending ? `${pending} pending confirmation` : null, ready ? `${ready} ready for approval` : null].filter(Boolean) as string[];
    const base = v.visitsNeedingAttention === 0 ? "Nothing needs a decision now." : "Needs a review or a decision";
    const review = v.reviewOverdue ?? 0;
    const late = v.confirmationOverdue ?? 0;
    out.push({
      key: "visits", label: "Visit review", count: v.visitsNeedingAttention, unit: v.visitsNeedingAttention === 1 ? "visit" : "visits", to: "/visit-review",
      tone: review + late > 0 ? "amber" : "neutral",
      word: review > 0 ? "Urgent" : late > 0 ? "Overdue" : undefined,
      detail: [base, ...routine].join(" · "),
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
  const tone: Tone = o.urgent.items.some((i) => itemTone(i, Date.parse(o.asOf)) === "red") ? "red" : "amber";
  return { kind: "urgent", label: "Needs attention now", icon: TONE[tone].icon, count: n, aria: `Needs attention now: ${n} ${n === 1 ? "item" : "items"}`, tone };
}
