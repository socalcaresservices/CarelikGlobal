// The recipient's late-confirmation page (0036): no account; the token is in
// the URL fragment; a 6-digit code is required; wrong codes are explained;
// confirming sends the name, method, attestation and a response key once.
// In-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createAwsApiClient, createAwsPublicApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const TOKEN = "cd".repeat(32);
type Call = { path: string; body: Record<string, unknown> };

function setup() {
  const calls: Array<Call & { authorization?: string | undefined }> = [];
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ path: url.pathname, body, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.pathname === `/v1/public/visit-confirmations/${TOKEN}/open`) {
      if (body.code !== "123456") return json(422, { error: { code: "wrong_code", message: "That code is not correct. 4 attempts left." } });
      return json(200, { visit: { agencyName: "Synthetic Care Co", recipientName: "Synthetic Parent Rivera", serviceName: "Respite (synthetic)", serviceDate: "2026-10-04",
        timeIn: "2026-10-04T21:00:00Z", timeOut: "2026-10-04T22:00:00Z", workedMinutes: 60, caregiverFirstName: "Pat", timezone: "America/Los_Angeles", expiresAt: "2026-10-12T00:00:00Z", attemptsLeft: 4 } });
    }
    if (url.pathname === `/v1/public/visit-confirmations/${TOKEN}/respond`) return json(201, { received: true, outcome: body.outcome });
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => null), getAccessToken: vi.fn(async () => null), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => null, fetch: fetchImpl as never });
  const publicClient = createAwsPublicApiClient("https://api.example.test", fetchImpl as never);
  render(
    <MemoryRouter initialEntries={[`/confirm-visit#${TOKEN}`]}>
      <QueryClientProvider client={new QueryClient()}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={publicClient} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return calls;
}

describe("Confirm visit page (recipient, no account)", () => {
  it("needs the phone code; shows only the visit facts; a typed confirmation is sent once with attestation", async () => {
    const calls = setup();
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not correct. 4 attempts left.");
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Please check this visit")).toBeInTheDocument();
    expect(screen.getByText("2:00 PM – 3:00 PM")).toBeInTheDocument();
    expect(screen.getByText("10/04/2026")).toBeInTheDocument();
    expect(screen.getByText("Pat")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Yes, it happened as shown"));
    fireEvent.click(screen.getByRole("button", { name: "Type my name instead" }));
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tick the box");
    fireEvent.click(screen.getByLabelText(/I confirm that Pat provided Respite \(synthetic\) on 10\/04\/2026 from 2:00 PM – 3:00 PM/));
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    expect(await screen.findByText("Thank you. Your confirmation was sent.")).toBeInTheDocument();
    const sent = calls.find((c) => c.path.endsWith("/respond"))!;
    expect(sent.body).toMatchObject({ code: "123456", outcome: "confirmed", method: "typed", signerName: "Synthetic Parent Rivera", attested: true, signaturePng: null });
    expect(String(sent.body.responseKey)).toMatch(/^[0-9a-f-]{36}$/);
    // The token is only ever a path segment of the API call, never in a query string.
    expect(calls.every((c) => !c.path.includes("?"))).toBe(true);
    // Anonymous: no sign-in token is sent.
    expect(calls.every((c) => c.authorization === undefined)).toBe(true);
  });

  it("a problem can be reported instead, with a description", async () => {
    const calls = setup();
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByLabelText("No, something is wrong"));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Describe what is wrong");
    fireEvent.change(screen.getByLabelText("What is wrong?"), { target: { value: "The caregiver left at 2:30 PM" } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Thank you. Your report was sent.")).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith("/respond"))!.body).toMatchObject({ outcome: "disputed", method: null, disputeReason: "The caregiver left at 2:30 PM", attested: false });
  });
});
