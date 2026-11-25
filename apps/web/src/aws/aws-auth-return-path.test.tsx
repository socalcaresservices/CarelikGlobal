// An alert or email link to one shift must survive sign-in: the signed-out visitor is sent to the sign-in page, the full address (path AND ?shift=) is handed to the sign-in
// start, and after sign-in the same address is opened. SYNTHETIC ids only.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null as unknown, loading: false, signIn: vi.fn(async () => undefined), sessionExpired: false, error: null }));
vi.mock("@carelik/auth", () => ({ useAuth: () => auth }));
import { AwsLoginPage, AwsProtectedRoute } from "./aws-auth-pages";

afterEach(() => { cleanup(); auth.user = null; auth.signIn.mockClear(); });
const SHIFT = "51515151-0000-4000-8000-000000000001";
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p>; }
const app = (at: string) => render(
  <MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="/login" element={<AwsLoginPage />} />
      <Route path="/my-shifts" element={<AwsProtectedRoute><Where /></AwsProtectedRoute>} />
    </Routes>
  </MemoryRouter>);

describe("deep link through sign-in", () => {
  it("passes /my-shifts?shift=… to the sign-in start", async () => {
    app(`/my-shifts?shift=${SHIFT}`);
    const button = await screen.findByRole("button", { name: /sign in/i });
    fireEvent.click(button);
    await vi.waitFor(() => expect(auth.signIn).toHaveBeenCalledWith(`/my-shifts?shift=${SHIFT}`));
  });
  it("an already signed-in visitor lands on the same shift", async () => {
    auth.user = { sub: "x" };
    app(`/my-shifts?shift=${SHIFT}`);
    expect(await screen.findByTestId("where")).toHaveTextContent(`/my-shifts?shift=${SHIFT}`);
  });
});
