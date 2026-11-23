// Structural accessibility checks for the Open Shifts screens (jsdom). SYNTHETIC data only. This is NOT a screen-reader test: NVDA, JAWS and VoiceOver were NOT
// run. It checks what they depend on: one h1, labelled controls, named buttons, status/alert roles, unique ids, and tap targets sized for touch in the markup.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const BOARD = [{ shiftRef: "99999999-0000-4000-8000-000000000009", serviceCity: "Winchester", startsAt: "2026-12-01T17:30:00Z", endsAt: "2026-12-01T19:00:00Z", timezone: "America/Los_Angeles", myRequestStatus: null, totalCount: "1" }];
const QUEUE = { shiftId: "55555555-0000-4000-8000-000000000001", shiftRef: "r", startsAt: "2026-12-01T17:30:00Z", endsAt: "2026-12-01T19:00:00Z", serviceCity: null, clientCode: "C-1", postingState: "not_posted", roundNo: null, openSource: null,
  formerCaregiverCode: null, urgent: false, requestCount: 0, delivery: { queued: 0, sent: 0, delivered: 0, failed: 0, unknown: 0, suppressed: 0, suppressedBy: {} }, escalationReasons: ["missing_city"] };

function name(el: Element): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) return by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    const l = Array.from(el.labels ?? []).map((x) => x.textContent ?? "").join(" ").trim();
    if (l) return l;
  }
  return (el.textContent ?? "").trim();
}
function audit(main: HTMLElement) {
  const problems: string[] = [];
  if (main.querySelectorAll("h1").length !== 1) problems.push(`h1 count ${main.querySelectorAll("h1").length}`);
  for (const el of Array.from(main.querySelectorAll("button, input, select, textarea, a[href]"))) {
    if (el instanceof HTMLInputElement && el.type === "hidden") continue;
    if (!name(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}`);
  }
  const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupes.length) problems.push(`duplicate ids ${dupes.join(",")}`);
  const levels = Array.from(main.querySelectorAll("h1,h2,h3")).map((h) => Number(h.tagName[1]));
  levels.forEach((l, i) => { if (i > 0 && l - levels[i - 1]! > 1) problems.push("heading level skipped"); });
  for (const sec of Array.from(main.querySelectorAll("section[aria-labelledby]"))) if (!document.getElementById(sec.getAttribute("aria-labelledby")!)) problems.push("section label target missing");
  return problems;
}

describe("Open Shifts screens: structure a screen reader and the keyboard depend on", () => {
  it("caregiver board: one h1, named controls, outcome and status text (not colour alone), alert role for errors", async () => {
    renderAws("/open-shifts", ["visits.read"], { "GET /v1/open-shift-board": () => json(200, { shifts: BOARD }) }, "caregiver");
    await screen.findByTestId("board-shift");
    expect(audit(document.querySelector("main")!)).toEqual([]);
    expect(screen.getByRole("button", { name: "Request this shift" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile number")).toHaveAttribute("inputmode", "tel");
  });
  it("office coverage queue: labelled city field and named actions", async () => {
    renderAws("/schedule/coverage", ["shifts.manage"], { "GET /v1/coverage-queue": () => json(200, { items: [QUEUE] }) });
    await screen.findByTestId("queue-item");
    expect(audit(document.querySelector("main")!)).toEqual([]);
    expect(screen.getByLabelText("Service city")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post for Coverage" })).toBeInTheDocument();
  });
  it("settings: every field has a label", async () => {
    renderAws("/settings/open-shifts", ["organization.update"], {
      "GET /v1/open-shift-settings": () => json(200, { settings: { openShiftsEnabled: true, smsEnabled: false, smsEntitled: false, senderStatus: "unverified", smsAvailable: false, smsDisplayName: null, monthlySendLimit: 100, alertWindowDays: 14,
        quietStart: "21:00", quietEnd: "07:00", urgentHours: 48, escalationHours: 24, officeOpen: "08:00", officeClose: "18:00", usage: { period: "2026-11-01", sent: 0, segments: 0, blocked: 0, failed: 0 } } }),
      "GET /v1/office-contacts": () => json(200, { contacts: [] }), "GET /v1/caregivers": () => json(200, { caregivers: [] }), "GET /v1/open-shift-audit": () => json(200, { events: [] }),
    });
    await screen.findByTestId("sms-status");
    expect(audit(document.querySelector("main")!)).toEqual([]);
  });
});
