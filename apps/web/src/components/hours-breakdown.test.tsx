import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HoursBreakdown } from "./hours-breakdown";

afterEach(cleanup);

describe("HoursBreakdown closed, not billable", () => {
  const base = { authorizedMinutes: 600, hoursBillableMinutes: 0, hoursRoundingMinutes: 0, hoursPendingMinutes: 0, hoursReservedMinutes: 130, hoursLeftMinutes: 470, hoursOverLimitMinutes: 0 };
  it("names the held time and keeps the worked time on record, inside Reserved, without calling it Pending", () => {
    render(<HoursBreakdown row={{ ...base, hoursClosedNotBillableHeldMinutes: 130, hoursClosedNotBillableWorkedMinutes: 60 }} />);
    const note = screen.getByTestId("closed-not-billable");
    expect(note).toHaveTextContent("Closed, not billable");
    expect(note).toHaveTextContent("still held inside Reserved");
    expect(note).toHaveTextContent("worked is kept on record");
    expect(note.textContent).not.toMatch(/Pending/);
  });
  it("shows nothing extra when nothing is held", () => {
    render(<HoursBreakdown row={base} />);
    expect(screen.queryByTestId("closed-not-billable")).toBeNull();
  });
});
