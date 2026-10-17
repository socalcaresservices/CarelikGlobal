// Scheduling (0053): repeat patterns, make-up visits, hour limits, against an in-memory fake of the AWS API, through the real
// API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { buildPattern, describePattern, PLAIN_PATTERN } from "./recurring-format";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
const CG1 = "abababab-0000-4000-8000-000000000001";
const CANCELLED = "51515151-0000-4000-8000-000000000003";
const SERIES = "52525252-0000-4000-8000-000000000001";
type Call = { method: string; path: string; body: Record<string, unknown> | null; search: string };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const later = (hours: number) => new Date(Date.now() + hours * 3600e3).toISOString();

describe("pattern helpers", () => {
  it("builds nothing for a plain weekly series and describes the rest in plain words", () => {
    expect(buildPattern(PLAIN_PATTERN, "2026-11-02")).toBeNull();
    expect(buildPattern({ ...PLAIN_PATTERN, everyWeeks: 2, weekOffset: 1 }, "2026-11-02")).toEqual({ every_weeks: 2, anchor: "2026-11-09" });
    expect(buildPattern({ ...PLAIN_PATTERN, dates: "except", nth: [1] }, "2026-11-02")).toEqual({ except_nth: [1] });
    expect(buildPattern({ ...PLAIN_PATTERN, dates: "only", nth: [4, 2], excludeDates: ["2026-11-26"] }, "2026-11-02")).toEqual({ nth: [2, 4], exclude_dates: ["2026-11-26"] });
    expect(describePattern({ every_weeks: 2, anchor: "2026-11-02", except_nth: [1] })).toBe("every other week · except the first of the month");
    expect(describePattern({ nth: [2, 4], exclude_dates: ["2026-11-26"] })).toBe("only the second and fourth of the month · skips 1 date");
    expect(describePattern(null)).toBe("");
  });
});

function fakeApi() {
  const calls: Call[] = [];
  const permissions = ["assignments.manage", "authorizations.read", "caregivers.manage", "clients.names.read", "shifts.manage", "visits.manage", "visits.read"];
  const base = { clientId: CLIENT, clientCode: "CL-1", clientName: "Synthetic Client Alpha", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care",
    localDate: today, hasSignIn: true, reservedMinutes: 0, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, makeupForShiftId: null };
  const cancelled = { ...base, shiftId: CANCELLED, startsAt: later(30), endsAt: later(32), coverageState: "cancelled", caregiverRecordId: CG1, caregiverCode: "CG-1", caregiverName: "Synthetic Caregiver One" };
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  let limits: unknown[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, search: url.search });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/shifts":
        return json(200, { shifts: [cancelled] });
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [{ caregiverRecordId: CG1, caregiverCode: "CG-1", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 1, openVisits: 0 }] });
      case "GET /v1/shift-series":
        return json(200, { series: [{ seriesId: SERIES, status: "active", clientId: CLIENT, clientCode: "CL-1", clientName: "Synthetic Client Alpha", serviceId: SVC, serviceName: "Personal care", serviceCode: "PCS",
          caregiverRecordId: CG1, caregiverName: "Synthetic Caregiver One", weekdays: [6], startTime: "09:00:00", endTime: "11:00:00", startsOn: today, endsOn: null, generatedThrough: today,
          upcomingOccurrences: 3, skippedDates: [{ date: today, reason: "over_hour_limit", minutes: 120 }], pattern: { except_nth: [1] } }] });
      case "GET /v1/shift-series/preview":
        if (partialPreview) {
          const row = (d: string, outcome: string) => ({ localDate: d, startsAt: later(24), endsAt: later(26), minutes: 120, monthStart: today.slice(0, 8) + "01", authorizationLineageId: "l", authorizedMinutes: 240, usedMinutes: 0, reservedMinutes: 0, seriesMinutesBefore: 0, outcome });
          return json(200, { occurrences: [row("2026-11-02", "ok"), row("2026-11-03", "exceeds_authorization"), row("2026-11-04", "compliance_hold")] });
        }
        return json(200, { occurrences: [{ localDate: today, startsAt: later(24), endsAt: later(26), minutes: 120, monthStart: today.slice(0, 8) + "01", authorizationLineageId: "l", authorizedMinutes: 1800, usedMinutes: 0, reservedMinutes: 0, seriesMinutesBefore: 0, outcome: "ok" }] });
      case "POST /v1/shift-series":
        if (partialPreview) return json(201, { series: { seriesId: SERIES, created: 1, skipped: 2, reservedMinutes: 120, generatedThrough: today, rejected: [
          { localDate: "2026-11-03", reason: "exceeds_authorization", minutes: 120 }, { localDate: "2026-11-04", reason: "compliance_hold", minutes: 120 }] } });
        return json(201, { series: { seriesId: SERIES, created: 3, skipped: 0, reservedMinutes: 360, generatedThrough: today } });
      case `POST /v1/shifts/${CANCELLED}/makeup`:
        return json(201, { makeup: { shiftId: "new", startsAt: "x", endsAt: "y", reservedMinutes: 60, remainingMinutes: "300", unmadeMinutesAfter: 60 } });
      case "GET /v1/work-hour-policy":
        return json(200, { policy: policyApplies ? { applies: true, maxDailyMinutes: 480, maxWeeklyMinutes: 2400, version: 1, basis: "Synthetic" } : { applies: false } });
      case "GET /v1/hour-limits":
        return json(200, { limits });
      case "POST /v1/hour-limits":
        limits = [{ caregiverRecordId: null, caregiverName: null, maxDailyMinutes: body?.maxDailyMinutes ?? null, maxWeeklyMinutes: body?.maxWeeklyMinutes ?? null, mode: body?.mode }];
        return json(200, { ok: true });
      case "GET /v1/caregiver-load":
        return json(200, { load: [{ caregiverRecordId: CG1, caregiverName: "Synthetic Caregiver One", weekStart: today, scheduledMinutes: "540", busiestDay: today, busiestDayMinutes: "300",
          maxDailyMinutes: 240, maxWeeklyMinutes: 2400, mode: "report", overDaily: true, overWeekly: false }] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

let policyApplies = false;
let partialPreview = false;
function renderAt(path: string) {
  const api = fakeApi();
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return api;
}
afterEach(() => vi.clearAllMocks());

describe("Scheduling page", () => {
  it("sends the chosen repeat rule with the preview and the saved series", async () => {
    const api = renderAt("/schedule");
    expect(await screen.findByRole("heading", { name: "Scheduling" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Repeat visits" }));
    await screen.findByRole("option", { name: /Synthetic Client Alpha/ });
    await screen.findByRole("option", { name: /Personal care/ });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.change(screen.getByLabelText("Weeks"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Dates in the month"), { target: { value: "except" } });
    fireEvent.click(within(screen.getByRole("group", { name: /matching days/i })).getByLabelText("1st"));
    fireEvent.click(screen.getByRole("button", { name: "Preview dates and hours" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create series" }));
    expect(await screen.findByText(/Series created: 3 shifts/)).toBeInTheDocument();
    const preview = api.calls.find((c) => c.path === "/v1/shift-series/preview")!;
    expect(JSON.parse(new URLSearchParams(preview.search).get("pattern")!)).toEqual({ every_weeks: 2, anchor: today, except_nth: [1] });
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/shift-series")!.body).toMatchObject({ weekdays: [6], pattern: { every_weeks: 2, anchor: today, except_nth: [1] } });
  });

  it("lists a series with its rule in plain words and why dates were skipped", async () => {
    renderAt("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: "Manage repeating shifts" }));
    expect(await screen.findByText(/except the first of the month/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/1 skipped date/));
    expect(screen.getByText(/Over the caregiver's hour limit/)).toBeInTheDocument();
  });

  it("offers a make-up on a cancelled shift and reports what is still owed", async () => {
    const api = renderAt("/schedule");
    const row = (await screen.findByText(/Synthetic Caregiver One/)).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Schedule make-up" }));
    fireEvent.click(within(row).getAllByRole("button", { name: "Schedule make-up" }).at(-1)!);
    expect(await screen.findByText(/Make-up scheduled: 1 hr reserved.*1 hr of the missed time is still not made up/s)).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === `/v1/shifts/${CANCELLED}/makeup`)!.body).toMatchObject({ organizationId: ORG, startTime: "09:00", endTime: "10:00", caregiverRecordId: CG1 });
  });

  it("shows each caregiver's week against their limit and saves a limit with a reason", async () => {
    const api = renderAt("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: "Hours and limits" }));
    expect(await screen.findByText(/Over the daily limit \(warning only\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Hours a day (optional)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Hours a week (optional)"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Agency policy (synthetic)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/hour-limits")!.body).toEqual({
      organizationId: ORG, caregiverRecordId: null, maxDailyMinutes: 480, maxWeeklyMinutes: 2400, mode: "report", reason: "Agency policy (synthetic)" });
    expect(await screen.findByText((_, el) => el?.tagName === "LI" && /Everyone \(agency default\).*8 hr a day.*40 hr a week.*warns only/.test(el.textContent ?? ""))).toBeInTheDocument();
  });

  it("states the agency's fixed limit, and says it cannot be overridden, when one applies", async () => {
    policyApplies = true;
    try {
      renderAt("/schedule");
      fireEvent.click(await screen.findByRole("button", { name: "Hours and limits" }));
      const banner = await screen.findByTestId("work-hour-policy");
      expect(banner).toHaveTextContent("Agency limit: 8 hr a day and 40 hr a week.");
      expect(banner).toHaveTextContent("always enforced and cannot be overridden or loosened here");
      expect(screen.queryByText(/No limits set/)).toBeNull();
    } finally {
      policyApplies = false;
    }
  });

  it("saves the dates that fit and lists EVERY date that was not saved, with its reason", async () => {
    partialPreview = true;
    try {
      const api = renderAt("/schedule");
      fireEvent.click(await screen.findByRole("button", { name: "Repeat visits" }));
      await screen.findByRole("option", { name: /Synthetic Client Alpha/ });
      await screen.findByRole("option", { name: /Personal care/ });
      fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT } });
      fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
      fireEvent.click(screen.getByLabelText("Sat"));
      fireEvent.click(screen.getByRole("button", { name: "Preview dates and hours" }));
      expect(await screen.findByText(/2 dates do not fit/)).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: /Create series: save the 1 that fit/ }));
      const panel = await screen.findByTestId("rejected-dates");
      expect(panel).toHaveTextContent("2 dates were not saved");
      expect(panel).toHaveTextContent("Over the month's authorized hours");
      expect(panel).toHaveTextContent("Caregiver is on a compliance hold"); // a newer reason code has a plain label
      expect(await screen.findByText(/Series created: 1 shifts scheduled.*2 dates were not saved/)).toBeInTheDocument();
      expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/shift-series")!.body).toMatchObject({ onConflict: "save_valid" });
    } finally {
      partialPreview = false;
    }
  });
});
