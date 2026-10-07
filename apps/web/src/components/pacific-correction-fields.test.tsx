// Reported 2026-10-05: opening Correct visit on an 11:23–11:27 PM visit
// (3 minutes, stored with seconds) previewed the unchanged form as 4 minutes.
// The preview must use the same rule as saving: an unchanged time keeps its
// stored instant. SYNTHETIC data only.
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { toPacificWallTime, type PacificWallTime } from "@/lib/service-verification";
import { PacificCorrectionFields } from "./pacific-time-out-field";

// 11:23:40 PM → 11:27:10 PM Pacific (PDT) on 10/04/2026 = 3 min 30 s → 3 whole minutes.
const IN = "2026-10-05T06:23:40.512Z";
const OUT = "2026-10-05T06:27:10.004Z";

function Harness({ edit }: { edit?: (w: PacificWallTime) => PacificWallTime }) {
  const [timeIn] = useState(toPacificWallTime(IN));
  const [timeOut] = useState(edit ? edit(toPacificWallTime(OUT)) : toPacificWallTime(OUT));
  return <PacificCorrectionFields originalTimeIn={IN} originalTimeOut={OUT} timeIn={timeIn} timeOut={timeOut} onTimeInChange={() => {}} onTimeOutChange={() => {}} />;
}

describe("Correct visit preview keeps recorded precision", () => {
  it("an unchanged form previews the original duration (3 min), not 4", () => {
    render(<Harness />);
    const summary = screen.getByLabelText("Correction summary");
    expect(summary).toHaveTextContent("Original10/04/2026, 11:23 PM → 10/04/2026, 11:27 PM (3 min)");
    expect(summary).toHaveTextContent("Corrected10/04/2026, 11:23 PM → 10/04/2026, 11:27 PM (3 min) · unchanged");
    expect(screen.queryByText(/recorded to the second/)).toBeNull();
  });

  it("a genuine edit shows the new duration and explains the seconds", () => {
    render(<Harness edit={(w) => ({ ...w, minute: 37 })} />);
    // Time In keeps 11:23:40; the new Time Out is exactly 11:37:00 → 13 min 20 s → 13 min.
    expect(screen.getByLabelText("Correction summary")).toHaveTextContent("11:37 PM (13 min)");
    expect(screen.getByText(/recorded to the second/)).toBeInTheDocument();
  });
});
