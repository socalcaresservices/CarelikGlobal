import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { getCurrentTenantContext } from "@/lib/tenant-resolver";
import { replaceBrowserLocation } from "@/lib/browser-navigation";
import { LoginPage } from "./login-page";

vi.mock("@carelik/auth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/tenant-resolver", () => ({
  getCurrentTenantContext: vi.fn(() => ({ type: "app" })),
  toAppUrl: vi.fn((path = "") => `https://app.ogevia.com${path}`),
}));

vi.mock("@/lib/browser-navigation", () => ({
  replaceBrowserLocation: vi.fn(),
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedGetCurrentTenantContext = vi.mocked(getCurrentTenantContext);
const mockedReplaceBrowserLocation = vi.mocked(replaceBrowserLocation);

function baseAuth() {
  return {
    user: null,
    session: null,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn(),
  };
}

function renderLoginPage(path = "/login") {
  window.history.pushState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>overview page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    window.history.pushState(null, "", "/");
    mockedGetCurrentTenantContext.mockReturnValue({ type: "app" });
  });

  it("shows the email/password form and a GitHub option when signed out", () => {
    mockedUseAuth.mockReturnValue(baseAuth());

    renderLoginPage();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
  });

  it("calls signInWithPassword with the entered credentials", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ ...baseAuth(), signInWithPassword });

    renderLoginPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@socalcares.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith(
        "owner@socalcares.com",
        "hunter2",
      ),
    );
  });

  it("shows an error message when password sign-in fails", async () => {
    const signInWithPassword = vi
      .fn()
      .mockRejectedValue(new Error("Invalid login credentials"));
    mockedUseAuth.mockReturnValue({ ...baseAuth(), signInWithPassword });

    renderLoginPage();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@socalcares.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() =>
      expect(screen.getByText("Invalid login credentials")).toBeInTheDocument(),
    );
  });

  it("calls signInWithGithub when the GitHub button is clicked", async () => {
    const signInWithGithub = vi.fn().mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ ...baseAuth(), signInWithGithub });

    renderLoginPage();
    screen.getByText("Sign in with GitHub").click();

    await waitFor(() => expect(signInWithGithub).toHaveBeenCalledTimes(1));
  });

  it("shows an error message when GitHub sign-in fails", async () => {
    const signInWithGithub = vi
      .fn()
      .mockRejectedValue(new Error("provider unreachable"));
    mockedUseAuth.mockReturnValue({ ...baseAuth(), signInWithGithub });

    renderLoginPage();
    screen.getByText("Sign in with GitHub").click();

    await waitFor(() =>
      expect(screen.getByText("provider unreachable")).toBeInTheDocument(),
    );
  });

  it("switches to the forgot-password form and sends a reset email", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ ...baseAuth(), resetPasswordForEmail });

    renderLoginPage();
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@socalcares.com" },
    });
    fireEvent.click(screen.getByText("Send reset link"));

    await waitFor(() =>
      expect(resetPasswordForEmail).toHaveBeenCalledWith(
        "owner@socalcares.com",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Check your email for a link to set a new password."),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Back to sign in"));
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("surfaces an error passed back in the URL query string", () => {
    mockedUseAuth.mockReturnValue(baseAuth());

    renderLoginPage("/login?error_description=Access%20denied");
    expect(screen.getByText("Access denied")).toBeInTheDocument();
  });

  it("redirects away from /login when already signed in", async () => {
    mockedUseAuth.mockReturnValue({
      ...baseAuth(),
      user: { id: "user-1" } as never,
      session: {} as never,
    });

    renderLoginPage();
    await waitFor(() =>
      expect(screen.getByText("overview page")).toBeInTheDocument(),
    );
  });

  it("returns through the role-aware root instead of replaying a stale Verify Visit route", async () => {
    mockedUseAuth.mockReturnValue({
      ...baseAuth(),
      user: { id: "owner-user" } as never,
      session: {} as never,
    });

    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/login",
            state: { from: { pathname: "/service-verification" } },
          },
        ]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>role-aware landing</div>} />
          <Route
            path="/service-verification"
            element={<div>verify visit page</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText("role-aware landing")).toBeInTheDocument(),
    );
    expect(screen.queryByText("verify visit page")).not.toBeInTheDocument();
  });

  it("does not navigate back to the marketing homepage after a successful sign-in", () => {
    mockedGetCurrentTenantContext.mockReturnValue({ type: "marketing" });
    mockedUseAuth.mockReturnValue({
      ...baseAuth(),
      user: { id: "user-1" } as never,
      session: {} as never,
    });

    renderLoginPage();

    expect(screen.getByText("Opening Ogevia…")).toBeInTheDocument();
    expect(screen.queryByText("overview page")).not.toBeInTheDocument();
    expect(mockedReplaceBrowserLocation).toHaveBeenCalledWith(
      "https://app.ogevia.com/",
    );
  });
});
