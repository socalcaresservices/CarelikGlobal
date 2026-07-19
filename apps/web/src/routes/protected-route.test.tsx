import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { ProtectedRoute } from "./protected-route";

vi.mock("@carelik/auth", () => ({
  useAuth: vi.fn()
}));

const mockedUseAuth = vi.mocked(useAuth);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div>secret content</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute", () => {
  it("shows a loading state while auth is resolving", () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: true,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderAt("/protected");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("redirects to /login when there is no user", async () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      session: null,
      loading: false,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderAt("/protected");
    await waitFor(() => expect(screen.getByText("login page")).toBeInTheDocument());
  });

  it("renders children when there is a user", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "user-1" } as never,
      session: {} as never,
      loading: false,
      signInWithGithub: vi.fn(),
      signOut: vi.fn()
    });

    renderAt("/protected");
    await waitFor(() => expect(screen.getByText("secret content")).toBeInTheDocument());
  });
});
