import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StaffVisitsPage } from "./staff-visits-page";

function renderPage() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<StaffVisitsPage />} />
        <Route path="/service-verification" element={<div>verification page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("StaffVisitsPage", () => {
  it("explains that caregivers cannot add or change visits", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Scheduled visits" })).toBeInTheDocument();
    expect(screen.getByText(/Your agency manages visit scheduling/)).toBeInTheDocument();
    expect(screen.getByText(/Contact an administrator when a visit needs to be added or changed/)).toBeInTheDocument();
  });

  it("does not expose caregiver self-scheduling controls", () => {
    renderPage();

    expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ends")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add visit/i })).not.toBeInTheDocument();
  });

  it("routes the caregiver to Shift Verification", () => {
    renderPage();

    fireEvent.click(screen.getByRole("link", { name: "Open Shift Verification" }));
    expect(screen.getByText("verification page")).toBeInTheDocument();
  });
});
