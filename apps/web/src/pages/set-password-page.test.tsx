import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@carelik/auth";
import { SetPasswordPage } from "./set-password-page";

vi.mock("@carelik/auth", () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);

function baseAuth() {
  return {
    user: { id: "user-1" } as never,
    session: {} as never,
    loading: false,
    signInWithGithub: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn()
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/set-password"]}>
      <Routes>
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route path="/" element={<div>app home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("SetPasswordPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a link-expired message when there is no session", () => {
    mockedUseAuth.mockReturnValue({ ...baseAuth(), user: null });

    renderPage();
    expect(screen.getByText("Link expired")).toBeInTheDocument();
  });

  it("requires a password of at least 8 characters", () => {
    const updatePassword = vi.fn();
    mockedUseAuth.mockReturnValue({ ...baseAuth(), updatePassword });

    renderPage();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "short" } });
    fireEvent.click(screen.getByText("Set password and continue"));

    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("requires the confirmation to match", () => {
    const updatePassword = vi.fn();
    mockedUseAuth.mockReturnValue({ ...baseAuth(), updatePassword });

    renderPage();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different1" } });
    fireEvent.click(screen.getByText("Set password and continue"));

    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("calls updatePassword and redirects home on success", async () => {
    const updatePassword = vi.fn().mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ ...baseAuth(), updatePassword });

    renderPage();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByText("Set password and continue"));

    await waitFor(() => expect(updatePassword).toHaveBeenCalledWith("longenough1"));
    await waitFor(() => expect(screen.getByText("app home")).toBeInTheDocument());
  });

  it("shows an error message when updatePassword fails", async () => {
    const updatePassword = vi.fn().mockRejectedValue(new Error("Session expired"));
    mockedUseAuth.mockReturnValue({ ...baseAuth(), updatePassword });

    renderPage();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByText("Set password and continue"));

    await waitFor(() => expect(screen.getByText("Session expired")).toBeInTheDocument());
  });
});
