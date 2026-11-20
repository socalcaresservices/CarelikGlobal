// After any change to a shift (add, assign, call-out, cancel, change time, make-up, claim, withdraw, confirm or decline a pickup), every screen that shows
// shifts or what they imply must refetch, so the person never reads a stale number: the Schedule lists, the Home dashboard (action items, today's shifts,
// authorization use), the attention counts, the hours and load figures, and the request lists (care requests, offers, alerts, pickups, matches). One list here, used by every shift mutation (owner, 2026-11-20).
import type { QueryClient } from "@tanstack/react-query";

/** Shift lists, every view of open and own shifts. */
export const SHIFT_QUERY_KEYS = ["aws-shifts", "aws-open-shifts", "aws-my-shifts", "aws-shift-series"] as const;
/** The Home dashboard and the counts that follow from shifts: action items, attention, authorization use, hours and caregiver load. */
export const DASHBOARD_QUERY_KEYS = ["action-issues", "attention-overview", "aws-attention", "aws-utilisation", "aws-hour-limits", "aws-caregiver-load"] as const;

/** Requests that depend on shifts: care requests and their offers and alerts, pickup requests, and the caregiver matches for a shift. */
export const REQUEST_QUERY_KEYS = ["care-requests", "care-offers", "care-notifications", "aws-pickups", "shift-matches", "my-care-opportunities"] as const;

export const SHIFT_CHANGE_QUERY_KEYS: readonly string[] = [...SHIFT_QUERY_KEYS, ...DASHBOARD_QUERY_KEYS, ...REQUEST_QUERY_KEYS];

/** Marks everything a shift change can affect as stale and refetches what is on screen. Never throws: a failed refetch must not turn a saved change into an error. */
export async function refreshAfterShiftChange(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  await Promise.all(SHIFT_CHANGE_QUERY_KEYS.map((key) => Promise.resolve(queryClient.invalidateQueries({ queryKey: [key] })).catch(() => undefined)));
}
