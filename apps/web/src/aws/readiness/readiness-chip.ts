import type { Tone } from "../profile-ui";
import type { ReadinessItem } from "./readiness-data";

/** The one word a row shows as its status. Saved, pending review and approved are different words with different colours; an agency setup gap is never shown as a failure of the caregiver. */
export function chipFor(i: ReadinessItem): { label: string; tone: Tone } {
  const d = i.detail ?? "";
  if ((i.requirement === "cpr" || i.requirement === "tb") && /not set up/i.test(d)) return { label: "Setup needed", tone: "warn" };
  // 0123: an admin override is shown, never mistaken for a verification; an enforced, unlifted document issue is simply Blocked
  if (i.extra.override && typeof i.extra.override === "object") return { label: "Admin Approved", tone: "override" };
  if (i.extra.issueKey && i.blocksShifts) return { label: "Blocked", tone: "bad" };
  if (i.state === "met") return { label: i.requirement === "training" ? "Complete" : i.requirement === "signin" ? "Signed in" : "Verified", tone: "ok" };
  if (/waiting for review/i.test(d)) return { label: "Pending review", tone: "warn" };
  if (i.state === "overdue") return { label: "Overdue", tone: "bad" };
  if (i.state === "problem") return { label: /rejected/i.test(d) ? "Rejected" : /expired/i.test(d) ? "Expired" : "Needs attention", tone: "bad" };
  if (i.requirement === "background" && /requested/i.test(d)) return { label: "Requested", tone: "saved" };
  if (i.requirement === "signin") return { label: "Not signed in", tone: "neutral" };
  if (i.state === "pending") return { label: "Due soon", tone: "warn" };
  return { label: "Not recorded", tone: "neutral" };
}

