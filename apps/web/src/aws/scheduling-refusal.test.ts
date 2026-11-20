import { describe, expect, it } from "vitest";
import { schedulingRefusal } from "./scheduling-refusal";

const err = (m: string) => new Error(m);
const FB = "Not saved.";

describe("schedulingRefusal", () => {
  it("keeps the server's sentence word for word and adds one next step for refusals it recognises", () => {
    const cases: Array<[string, RegExp]> = [
      ["This caregiver already has a shift at that time", /Pick another time, or choose a different caregiver/],
      ["Not enough authorized time remains this month for this shift: 2 h available, this shift needs 3 h", /ask an administrator to review the authorization/],
      ["No current authorization covers this client and service on that date", /Add or renew the authorization/],
      ["Only caregivers who are Ready to work or Active can be scheduled", /Finish the caregiver's onboarding/],
      ["This caregiver has a visit in progress; end or close it first", /End or close that visit first/],
      ["This shift was just filled", /Refresh the schedule/],
      ["This caregiver called out of this shift; choose someone else", /Choose someone else/],
      ["A visit is linked to this shift; it cannot be moved", /Record what happened as a visit/],
      ["Give a reason for changing the caregiver", /Type a short reason/],
      ["You do not have permission to reconcile shifts", /Ask an administrator/],
    ];
    for (const [server, step] of cases) {
      const out = schedulingRefusal(err(server), FB);
      expect(out.startsWith(server.replace(/[.\s]+$/, ""))).toBe(true);
      expect(out).toMatch(/\. What to do: /);
      expect(out).toMatch(step);
    }
  });

  it("shows an unrecognised message unchanged, and the fallback when there is no message", () => {
    expect(schedulingRefusal(err("Something unusual happened"), FB)).toBe("Something unusual happened");
    expect(schedulingRefusal(err("  "), FB)).toBe(FB);
    expect(schedulingRefusal("not an error", FB)).toBe(FB);
    expect(schedulingRefusal(undefined, FB)).toBe(FB);
  });

  it("says nothing was saved when the request never reached the server", () => {
    for (const cause of [new TypeError("Failed to fetch"), err("NetworkError when attempting to fetch resource.")]) {
      expect(schedulingRefusal(cause, FB)).toBe("The request did not reach the server, so nothing was saved. Check your connection and try again.");
    }
  });

  it("never adds a step twice and does not leak anything but the server's own words", () => {
    const once = schedulingRefusal(err("This shift was just filled"), FB);
    expect(schedulingRefusal(err(once), FB)).toBe(once);
    expect((once.match(/What to do:/g) ?? []).length).toBe(1);
  });
});
