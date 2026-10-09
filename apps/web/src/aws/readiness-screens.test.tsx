// Readiness and matching screens (0039-0041) with a fake API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwsApiClient } from "@/lib/aws-api";
import { AwsApiContext } from "./aws-workspace";
import { MatchPanel } from "./match-panel";
import { AvailabilityReviewCard, ExperienceTagsCard, MyExperienceCard, ReadinessSettingsCard } from "./readiness-cards";
import { fakeCandidate, fakeMatches } from "./readiness-test-fakes";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
vi.mock("@/providers/organization-provider", () => ({
  useOrganization: () => ({ activeOrganizationId: ORG, hasPermission: () => true }),
}));

type Post = { path: string; body: unknown; key?: string };
function setup(get: (path: string, query?: Record<string, string | null | undefined>) => unknown, onPost?: (path: string, body: unknown) => unknown) {
  const posts: Post[] = [];
  const api: AwsApiClient = {
    get: vi.fn(async (path: string, query) => get(path, query)) as never,
    post: vi.fn(async (path: string, body: unknown, options) => {
      posts.push({ path, body, key: options?.idempotencyKey });
      if (onPost) return onPost(path, body);
      return {};
    }) as never,
  };
  const wrap = (node: React.ReactNode) => (
    <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AwsApiContext.Provider value={api}>{node}</AwsApiContext.Provider></QueryClientProvider></MemoryRouter>
  );
  return { api, posts, wrap };
}
afterEach(cleanup);

const input = { clientId: "c1", serviceId: "s1", occurrences: [{ startsAt: "2026-11-02T17:00:00Z", endsAt: "2026-11-02T19:00:00Z" }] };

describe("Matches table and Why this match", () => {
  it("ranks as the server returned, shows Incomplete instead of a made-up score, and explains the parts", async () => {
    const incomplete = fakeCandidate({
      caregiverRecordId: "g2", caregiverCode: "CG-9", caregiverName: "Synthetic Nine", score: null, scoreStatus: "incomplete", approxDistanceMiles: null,
      components: [
        { key: "availability", status: "known", value: 0.5, weight: 0.5, points: 25, detail: { coveredMinutes: 60, requestedMinutes: 120 }, source: {} },
        { key: "location", status: "unknown", value: null, weight: 0.25, points: null, detail: { caregiverLocation: "not recorded", clientLocation: "recorded" }, source: {} },
        { key: "experience", status: "not_applicable", value: null, weight: 0, points: null, detail: {}, source: {} },
      ],
    });
    const { api, wrap } = setup(() => ({}), () => fakeMatches([fakeCandidate(), incomplete]));
    const onAction = vi.fn();
    render(wrap(<MatchPanel api={api} organizationId={ORG} input={input} actionLabel="Ask availability" onAction={onAction} />));
    const table = await screen.findByRole("table", { name: "Caregiver matches, best first" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Synthetic Caregiver Two");
    expect(rows[0]).toHaveTextContent("87");
    expect(rows[0]).toHaveTextContent("~4.2 mi");
    expect(rows[1]).toHaveTextContent("Incomplete");
    expect(rows[1]).toHaveTextContent("Not available");
    expect(screen.getByText(/Sorted by eligibility/)).toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Why" }));
    await screen.findByText(/Why this match — Synthetic Nine/);
    expect(screen.getByText(/an input is unknown, so no number is shown/)).toBeInTheDocument();
    expect(screen.getByText("ZIP not recorded (caregiver)")).toBeInTheDocument();
    expect(screen.getByText(/Not requested/)).toBeInTheDocument();
    expect(screen.getByText("1 hr of 2 hr covered")).toBeInTheDocument();

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Ask availability" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ caregiverCode: "CG-2" }));
  });

  it("does not let a not-eligible caregiver be chosen and says why", async () => {
    const blocked = fakeCandidate({ eligibility: "not_eligible", score: null, scoreStatus: "incomplete", reasons: [{ code: "SERVICE", label: "Not approved for this service" }] });
    const { api, wrap } = setup(() => ({}), () => fakeMatches([blocked], "off"));
    render(wrap(<MatchPanel api={api} organizationId={ORG} input={input} actionLabel="Choose" onAction={vi.fn()} />));
    expect(await screen.findByText("Not approved for this service")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("shown as unchecked, not as passed");
  });

  it("shows a recoverable error and an empty state", async () => {
    let fail = true;
    const { api, wrap } = setup(() => ({}), () => { if (fail) throw new Error("Could not reach Ogevia."); return fakeMatches([]); });
    render(wrap(<MatchPanel api={api} organizationId={ORG} input={input} actionLabel="Choose" onAction={vi.fn()} />));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Ogevia.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No caregivers with Ready or Active status/)).toBeInTheDocument();
  });
});

describe("Availability review", () => {
  const request = {
    requestId: "r1", caregiverRecordId: "g1", caregiverCode: "CG-1", caregiverName: "Synthetic One", status: "pending", reason: "New job on Fridays",
    requestedAt: "2026-10-05T17:00:00Z", requestedByName: "Synthetic One", stale: true,
    proposedWindows: [{ weekday: 5, specificDate: null, startLocal: "08:00", endLocal: "12:00" }], proposedUnavailable: [],
    currentWindows: [{ weekday: 1, specificDate: null, startLocal: "08:00", endLocal: "17:00" }], currentUnavailable: [],
  };
  it("compares approved vs requested, flags a stale baseline, requires a note to decline, and sends the decision with an idempotency key", async () => {
    const { wrap, posts } = setup((path) => (path === "/v1/availability/requests" ? { requests: [request] } : {}));
    render(wrap(<AvailabilityReviewCard />));
    expect(await screen.findByText("New job on Fridays", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Approved availability changed after this was sent");
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByText("Mon 8 AM–5 PM")).toBeInTheDocument();
    expect(screen.getByText("Fri 8 AM–12 PM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Need Fridays covered" } });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: "/v1/availability/requests/r1/review", body: { decision: "decline", note: "Need Fridays covered" } });
    expect(posts[0]!.key).toBeTruthy();
  });
});

describe("Settings and experience", () => {
  it("settings need a reason and send only the group that changed", async () => {
    const get = (path: string) => path === "/v1/readiness/settings"
      ? { readiness: { serviceChecksEnabled: false, availabilityRequired: false, expiryWarningDays: 30 } }
      : { match: { referenceRadiusMiles: 15, locationEnabled: true } };
    const { wrap, posts } = setup(get);
    render(wrap(<ReadinessSettingsCard />));
    const toggle = await screen.findByRole("checkbox", { name: /Require explicit service approval/ });
    expect(toggle).not.toBeChecked(); // enforcement starts OFF; nothing turns it on implicitly
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled(); // reason still required
    fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: "Approvals entered for all caregivers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: "/v1/readiness/settings", body: { serviceChecksEnabled: true, availabilityRequired: false, expiryWarningDays: 30 } });
  });

  it("a caregiver submits experience for review; it is shown as awaiting review, not verified", async () => {
    let list: unknown[] = [];
    const get = (path: string) => path === "/v1/experience-tags" ? { tags: [{ tagId: "t1", name: "Dementia care", isActive: true }] } : path === "/v1/experience/me" ? { experience: list } : {};
    const { wrap, posts } = setup(get, () => { list = [{ experienceId: "e1", tagId: "t1", tagName: "Dementia care", context: null, source: "caregiver", status: "pending", reviewedByName: null, reviewNote: null, profileReviewedAt: null }]; return { experienceId: "e1" }; });
    render(wrap(<MyExperienceCard />));
    await screen.findByRole("option", { name: "Dementia care" });
    fireEvent.change(screen.getByLabelText("Experience"), { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: "/v1/experience/me", body: { tagId: "t1" } });
    expect(await screen.findByText("Awaiting review")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).toBeNull();
  });
});

describe("Experience tags", () => {
  it("starts empty (nothing pre-loaded), adds a tag, and turning one off needs a reason", async () => {
    let tags: unknown[] = [];
    const { wrap, posts } = setup((path) => (path === "/v1/experience-tags" ? { tags } : {}), (path) => { if (path === "/v1/experience-tags") tags = [{ tagId: "t9", name: "Hospice support", isActive: true }]; return {}; });
    render(wrap(<ExperienceTagsCard />));
    expect(await screen.findByText(/No tags yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "Hospice support" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: "/v1/experience-tags", body: { name: "Hospice support" } });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(screen.getAllByRole("button", { name: "Turn off" }).at(-1)).toBeDisabled();
  });
});
