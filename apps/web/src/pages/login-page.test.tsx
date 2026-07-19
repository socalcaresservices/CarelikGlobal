import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { LoginPage } from "./login-page";

vi.mock("@carelik/auth", () => ({
  useAuth: vi.fn()
}));

const mockedUseAuth = vi.mocked(useAuth);

function renderLoginPage(path = "/login") {
  window.history.pushState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>overview page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("shows a sign-in button when signed out", () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderLoginPage();
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
  });

  it("calls signInWithGithub when the button is clicked", async () => {
    const signInWithGithub = vi.fn().mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signInWithGithub,
      signOut: vi.fn()
    });

    renderLoginPage();
    screen.getByText("Sign in with GitHub").click();

    await waitFor(() => expect(signInWithGithub).toHaveBeenCalledTimes(1));
  });

  it("shows an error message when sign-in fails", async () => {
    const signInWithGithub = vi.fn().mockRejectedValue(new Error("provider unreachable"));
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signInWithGithub,
      signOut: vi.fn()
    });

    renderLoginPage();
    screen.getByText("Sign in with GitHub").click();

    await waitFor(() => expect(screen.getByText("provider unreachable")).toBeInTheDocument());
  });

  it("surfaces an error passed back in the URL query string", () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderLoginPage("/login?error_description=Access%20denied");
    expect(screen.getByText("Access denied")).toBeInTheDocument();
  });

  it("redirects away from /login when already signed in", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-1" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderLoginPage();
    await waitFor(() => expect(screen.getByText("overview page")).toBeInTheDocument());
  });
});
