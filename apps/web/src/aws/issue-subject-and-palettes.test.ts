import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { issueSubject } from "./action-issues";
import { DASHBOARD_PALETTES, useDashboardAppearance } from "./appearance/appearance-hooks";

const noCaregiver = { kind: "shift", clientName: "Client A", clientCode: "C-1", duplicateName: false, caregiverCode: null };
const base = { kind: "shift", clientName: "Client A", clientCode: "C-1", duplicateName: false, caregiverName: "Caregiver B", caregiverCode: "G-1", caregiverDuplicateName: false };

describe("dashboard issue rows name the right person", () => {
  it("a caregiver's document problem names the caregiver, with the client beside it", () => {
    expect(issueSubject({ ...base, reason: "documents_not_current" })).toEqual({ main: "Caregiver B", other: "Client A" });
  });
  it("a compliance hold names the caregiver", () => {
    expect(issueSubject({ ...base, reason: "compliance_hold" }).main).toBe("Caregiver B");
  });
  it("a coverage problem still names the client", () => {
    expect(issueSubject({ ...noCaregiver, reason: "uncovered_open" })).toEqual({ main: "Client A", other: null });
  });
  it("falls back to the client when no caregiver is visible to this role", () => {
    expect(issueSubject({ ...noCaregiver, reason: "documents_not_current" })).toEqual({ main: "Client A", other: null });
  });
});

describe("dashboard chart colors", () => {
  beforeEach(() => localStorage.clear());
  it("offers four color schemes, including primary colors and the Ogevia brand colors", () => {
    expect(Object.values(DASHBOARD_PALETTES).map((p) => p.name)).toEqual(["Care blue", "Blue shades", "Primary colors", "Ogevia"]);
    for (const p of Object.values(DASHBOARD_PALETTES)) expect(new Set(p.colors).size).toBe(4);
  });
  it("remembers a new scheme and ignores an unknown saved value", () => {
    localStorage.setItem("ogevia.dashboard.palette", "primary");
    expect(renderHook(() => useDashboardAppearance()).result.current.palette).toBe("primary");
    localStorage.setItem("ogevia.dashboard.palette", "nonsense");
    expect(renderHook(() => useDashboardAppearance()).result.current.palette).toBe("care");
  });
});
