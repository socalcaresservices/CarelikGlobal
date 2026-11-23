// Phase 5 (stabilization): the Dashboard "Hours by service" table sorts by every column with the shared pattern.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HoursByServiceTable } from "./home-page";
import type { UtilisationRow } from "./aws-workspace";

const row = (serviceId: string, serviceName: string, authorizedMinutes: number, workedMinutes: number): UtilisationRow => ({
  serviceId, serviceCode: serviceId.toUpperCase(), serviceName, clientCount: 1, authorizedMinutes, scheduledMinutes: 0, workedMinutes,
  billableMinutes: 0, reviewMinutes: 0, approvedMinutes: 0, remainingMinutes: authorizedMinutes - workedMinutes, lineagesWithoutRate: 0,
  billableValueCents: null, approvedValueCents: null, unusedValueCents: null,
} as unknown as UtilisationRow);
const ROWS = [row("b", "Respite", 600, 120), row("a", "Attendant", 1200, 60), row("c", "Community", 300, 300)];
const names = () => within(screen.getAllByRole("rowgroup")[1]!).getAllByRole("row").map((r) => within(r).getByRole("rowheader").textContent?.split(" (")[0]);

describe("Hours by service sorting", () => {
  it("keeps the server order until a heading is clicked, then sorts text and number columns both ways", () => {
    render(<MemoryRouter><HoursByServiceTable rows={ROWS} hasHoursData={false} /></MemoryRouter>);
    expect(names()).toEqual(["Respite", "Attendant", "Community"]);
    fireEvent.click(screen.getByRole("button", { name: /^Service/ }));
    expect(names()).toEqual(["Attendant", "Community", "Respite"]);
    fireEvent.click(screen.getByRole("button", { name: /^Authorized/ }));
    expect(names()).toEqual(["Community", "Respite", "Attendant"]);
    fireEvent.click(screen.getByRole("button", { name: /^Authorized/ }));
    expect(names()).toEqual(["Attendant", "Respite", "Community"]);
    fireEvent.click(screen.getByRole("button", { name: /^Worked$/ }));
    expect(names()).toEqual(["Attendant", "Respite", "Community"]);
  });
});
