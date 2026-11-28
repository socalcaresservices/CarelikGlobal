// 0124: the home label page and the sign-now / sign-later panel. SYNTHETIC data; the fake API records every request.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const TOKEN = "ab".repeat(32);
const VISIT = "bbbbbbbb-0000-4000-8000-000000000002";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
// jsdom has no PointerEvent: without it fireEvent drops clientX/clientY and the pad would record NaN.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {}, setTransform() {}, clearRect() {} })) as never;

type Body = { strokes?: { strokes: unknown[][] }; [k: string]: unknown };
type Req = { method: string; path: string; body: Body; key: string | null };
function renderPage(handlers: { preview: () => Response; punch?: (req: Req) => Response | Promise<Response>; other?: (req: Req) => Response | null }) {
  const requests: Req[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Req = { method: init?.method ?? "GET", path: url.pathname, body: (init?.body ? JSON.parse(String(init.body)) : {}) as Body, key: (init?.headers as Record<string, string> | undefined)?.["idempotency-key"] ?? null };
    if (req.path !== "/v1/me") requests.push(req);
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "caregiver", permissions: [] }], profile: { displayName: "Synthetic Caregiver" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/label-punch/preview": return handlers.preview();
      case "/v1/label-punch": return handlers.punch ? handlers.punch(req) : json(200, {});
      default: return handlers.other?.(req) ?? json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: Date.now() + 3_600_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/l"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { requests };
}
beforeEach(() => { sessionStorage.setItem("ogevia.label.pending", JSON.stringify({ token: TOKEN, expires: Date.now() + 60_000 })); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks(); });

const READY_ARRIVAL = { state: "ready", action: "arrival", organizationId: ORG, clientCode: "CL-TEST000001", city: "Synthetictown", shifts: [{ id: "s1", startsAt: "2026-11-23T17:00:00Z", endsAt: "2026-11-23T19:00:00Z" }] };

describe("home label page", () => {
  it("previewing writes nothing: only the preview request is sent until the person presses Clock in", async () => {
    const { requests } = renderPage({ preview: () => json(200, READY_ARRIVAL) });
    await screen.findByRole("button", { name: "Clock in" }, { timeout: 15000 });
    expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/v1/label-punch/preview"]);
    expect(screen.getByText(/Client CL-TEST000001/)).toBeInTheDocument();
  });
  it("Clock in sends the token, the intent and a retry key (no organization, no time); the saved time and the location result are shown", async () => {
    const { requests } = renderPage({ preview: () => json(200, READY_ARRIVAL),
      punch: () => json(200, { outcome: "saved", intent: "arrival", visitId: VISIT, savedAt: "2026-11-23T17:02:00Z", locationResult: "unavailable", organizationId: ORG }) });
    fireEvent.click(await screen.findByRole("button", { name: "Clock in" }, { timeout: 15000 }));
    await screen.findByTestId("saved-title");
    const punch = requests.find((r) => r.path === "/v1/label-punch")!;
    expect(punch.body).toEqual({ token: TOKEN, intent: "arrival" });                        // jsdom has no geolocation: no coordinates are sent, the server records "unavailable"
    expect(punch.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByTestId("saved-time")).toHaveTextContent(/Saved/);
    expect(screen.getByText(/location was not available/i)).toBeInTheDocument();
  });
  it("when the answer is lost the screen does not say it saved; pressing again reuses the SAME retry key", async () => {
    let calls = 0;
    const { requests } = renderPage({ preview: () => json(200, READY_ARRIVAL),
      punch: () => { calls++; if (calls === 1) throw new TypeError("network down"); return json(200, { outcome: "saved", intent: "arrival", visitId: VISIT, savedAt: "2026-11-23T17:02:00Z", organizationId: ORG, replayed: true }); } });
    fireEvent.click(await screen.findByRole("button", { name: "Clock in" }, { timeout: 15000 }));
    await screen.findByText(/could not confirm that this was saved/i);
    expect(screen.queryByTestId("saved-title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clock in" }));
    await screen.findByTestId("saved-title");
    const keys = requests.filter((r) => r.path === "/v1/label-punch").map((r) => r.key);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  });
  it("a refused arrival shows the server's plain reason and nothing as saved", async () => {
    renderPage({ preview: () => json(200, READY_ARRIVAL), punch: () => json(200, { outcome: "not_saved", reason: "already_clocked_in", message: "You are already clocked in here.", intent: "arrival" }) });
    fireEvent.click(await screen.findByRole("button", { name: "Clock in" }, { timeout: 15000 }));
    expect(await screen.findByTestId("not-saved")).toHaveTextContent("Not saved. You are already clocked in here.");
    expect(screen.queryByTestId("saved-title")).toBeNull();
  });
  it("two valid visits: the person chooses one and the choice is sent", async () => {
    const two = { ...READY_ARRIVAL, action: "choose", shifts: [{ id: "s1", startsAt: "2026-11-23T17:00:00Z", endsAt: "2026-11-23T18:00:00Z" }, { id: "s2", startsAt: "2026-11-23T18:00:00Z", endsAt: "2026-11-23T20:00:00Z" }] };
    const { requests } = renderPage({ preview: () => json(200, two), punch: () => json(200, { outcome: "saved", intent: "arrival", visitId: VISIT, savedAt: "2026-11-23T18:01:00Z", organizationId: ORG }) });
    const button = await screen.findByRole("button", { name: "Clock in" }, { timeout: 15000 });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Which visit/), { target: { value: "s2" } });
    fireEvent.click(button);
    await screen.findByTestId("saved-title");
    expect(requests.find((r) => r.path === "/v1/label-punch")!.body).toMatchObject({ shiftId: "s2" });
  });
  it("a running visit offers Clock out (never another Clock in); early checkout asks first and then sends the confirmation", async () => {
    const running = { state: "ready", action: "departure", organizationId: ORG, clientCode: "CL-TEST000001", visit: { id: VISIT, timeIn: "2026-11-23T17:00:00Z" } };
    let n = 0;
    const { requests } = renderPage({ preview: () => json(200, running), punch: () => json(200, ++n === 1
      ? { outcome: "needs_confirmation", reason: "early_checkout", message: "This is much earlier than the scheduled end. Confirm to end the visit now.", intent: "departure" }
      : { outcome: "saved", intent: "departure", visitId: VISIT, savedAt: "2026-11-23T17:30:00Z", signing: "direct_required", locationResult: "outside_range", organizationId: ORG }) });
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Clock out" }, { timeout: 15000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, clock out now" }));
    await screen.findByTestId("saved-title");
    const sent = requests.filter((r) => r.path === "/v1/label-punch");
    expect(sent[0]!.body).toEqual({ token: TOKEN, intent: "departure" });
    expect(sent[1]!.body).toEqual({ token: TOKEN, intent: "departure", confirm: true });
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
    expect(screen.getByText(/office will confirm this visit with the client directly/i)).toBeInTheDocument();
    expect(screen.getByText(/not at the expected place/i)).toBeInTheDocument();
    expect(screen.queryByTestId("stroke-pad")).toBeNull();           // no signing on the phone after an off-site checkout of a home-only visit
  });
  it("an unavailable, revoked or other-agency label says so and offers no action", async () => {
    renderPage({ preview: () => json(200, { state: "unavailable" }) });
    await screen.findByText(/This label cannot be used/, undefined, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
  });
  it("a signed-in person whose account cannot use stickers is told so in plain words, sees no client information and has no clock-in button", async () => {
    renderPage({ preview: () => json(200, { state: "unavailable", reason: "not_authorized" }) });
    expect(await screen.findByTestId("denied", undefined, { timeout: 15000 })).toHaveTextContent(/Your Ogevia account is not set up to use this sticker\. Nothing was clocked\. Ask the office\./);
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
    expect(screen.queryByText(/Client /)).toBeNull();
  });
  it("a sticker for an address that is not the current one is refused in plain words, with no clock-in button", async () => {
    renderPage({ preview: () => json(200, { state: "blocked", reason: "address_not_current", organizationId: ORG, clientCode: "CL-TEST000001" }) });
    expect(await screen.findByTestId("denied", undefined, { timeout: 15000 })).toHaveTextContent(/not the current service address\. Nothing was clocked/);
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
    expect(screen.queryByRole("button", { name: /open visit/i })).toBeNull();
  });
  it("an assigned-to-nobody answer shows no client code and no action", async () => {
    renderPage({ preview: () => json(200, { state: "ready", action: "none", reason: "not_assigned", organizationId: ORG }) });
    await screen.findByText(/You are not assigned to this client\. Nothing was clocked\./, undefined, { timeout: 15000 });
    expect(screen.queryByText(/Client /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
  });
  it("another open visit blocks a new clock-in and points to it", async () => {
    renderPage({ preview: () => json(200, { state: "blocked", reason: "open_visit_elsewhere", organizationId: ORG, clientCode: "CL-X" }) });
    await screen.findByText(/another visit open/i, undefined, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: "Clock in" })).toBeNull();
    expect(screen.getByRole("button", { name: /Go to your open visit/ })).toBeInTheDocument();
  });
});

describe("sign now or later", () => {
  const running = { state: "ready", action: "departure", organizationId: ORG, clientCode: "CL-TEST000001", visit: { id: VISIT, timeIn: "2026-11-23T17:00:00Z" } };
  const saved = { outcome: "saved", intent: "departure", visitId: VISIT, savedAt: "2026-11-23T18:00:00Z", signing: "sign_now", locationResult: "within_range", organizationId: ORG };
  const session = { session: { sessionId: "cccccccc-0000-4000-8000-000000000003", expiresAt: "2026-11-23T18:10:00Z", serviceDate: "2026-11-23", timeIn: "2026-11-23T17:00:00Z", timeOut: "2026-11-23T18:00:00Z" } };
  const other = (onSign: (r: Req) => Response) => (r: Req) => r.path === `/v1/visits/${VISIT}/signature-session` ? json(200, session) : r.path === `/v1/visits/${VISIT}/sign` ? onSign(r) : r.path === `/v1/visits/${VISIT}/sign-later` ? json(200, { followupId: "f1" }) : null;
  const draw = () => {
    const canvas = screen.getByTestId("stroke-pad");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
    for (let i = 1; i < 30; i++) fireEvent.pointerMove(canvas, { clientX: 5 + i * 8, clientY: 5 + (i % 5) * 15, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  };
  it("shows the recorded date and times, needs a name, a drawing and the statement, then sends STROKES (never an image) and shows Signed", async () => {
    const { requests } = renderPage({ preview: () => json(200, running), punch: () => json(200, saved), other: other(() => json(200, { result: { status: "signed" } })) });
    fireEvent.click(await screen.findByRole("button", { name: "Clock out" }, { timeout: 15000 }));
    const times = await screen.findByTestId("signing-times", undefined, { timeout: 15000 });
    expect(within(times).getByText(/Started .* · Ended /)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save signature" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Name of the person signing/), { target: { value: "Synthetic Client" } });
    draw();
    expect(save).toBeDisabled();                                                                    // the statement is not accepted yet
    fireEvent.click(screen.getByLabelText(/I confirm that the date and times/));
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await screen.findByTestId("signed-note");
    expect(screen.getByTestId("signed-note")).toHaveTextContent(/^Signed /);
    const sent = requests.find((r) => r.path === `/v1/visits/${VISIT}/sign`)!;
    expect(sent.body).toMatchObject({ organizationId: ORG, sessionId: session.session.sessionId, signerRole: "client", signerName: "Synthetic Client", attested: true });
    expect(sent.body.strokes!.strokes[0]!.length).toBeGreaterThan(20);
    expect(JSON.stringify(sent.body)).not.toMatch(/data:image|base64|signaturePng/);
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("when a signing session has expired the pad is cleared and the person signs again on a fresh session", async () => {
    let first = true;
    const { requests } = renderPage({ preview: () => json(200, running), punch: () => json(200, saved),
      other: other(() => { if (first) { first = false; return json(409, { error: { code: "conflict", message: "This signing screen is no longer valid. Open it again to sign." } }); } return json(200, { result: { status: "signed" } }); }) });
    fireEvent.click(await screen.findByRole("button", { name: "Clock out" }, { timeout: 15000 }));
    await screen.findByTestId("signing-times", undefined, { timeout: 15000 });
    fireEvent.change(screen.getByLabelText(/Name of the person signing/), { target: { value: "Synthetic Client" } });
    draw(); fireEvent.click(screen.getByLabelText(/I confirm that the date and times/));
    fireEvent.click(await screen.findByRole("button", { name: "Save signature" }));
    await screen.findByText(/expired\. Please sign again/);
    expect(screen.getByRole("button", { name: "Save signature" })).toBeDisabled();               // the old drawing is gone
    draw();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save signature" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    await screen.findByTestId("signed-note");
    expect(requests.filter((r) => r.path.endsWith("/signature-session")).length).toBeGreaterThanOrEqual(2);
    const keys = requests.filter((r) => r.path.endsWith("/sign")).map((r) => r.key);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("sign later: the client cannot sign now; the reason is recorded and the page says the signature is pending", async () => {
    const { requests } = renderPage({ preview: () => json(200, running), punch: () => json(200, saved), other: other(() => json(200, {})) });
    fireEvent.click(await screen.findByRole("button", { name: "Clock out" }, { timeout: 15000 }));
    fireEvent.click(await screen.findByRole("button", { name: /client cannot sign right now/i }, { timeout: 15000 }));
    fireEvent.click(screen.getByRole("button", { name: /not available to sign/i }));
    await screen.findByText(/signature is pending/i);
    expect(requests.find((r) => r.path.endsWith("/sign-later"))!.body).toEqual({ reasonCode: "client_unavailable" });
  });
});
