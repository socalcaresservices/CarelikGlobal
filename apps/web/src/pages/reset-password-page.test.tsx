import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { ResetPasswordPage } from "./reset-password-page";

type AuthStateCallback = (event: string, session: unknown) => void;

let authStateCallback: AuthStateCallback | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((callback: AuthStateCallback) => {
        authStateCallback = callback;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      }),
      updateUser: vi.fn(),
      signOut: vi.fn()
    }
  }
}));

const mockedUpdateUser = vi.mocked(supabase.auth.updateUser);
const mockedSignOut = vi.mocked(supabase.auth.signOut);

function renderPage(path = "/reset-password") {
  window.history.pushState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function triggerRecovery() {
  act(() => {
    authStateCallback?.("PASSWORD_RECOVERY", {});
  });
}

describe("ResetPasswordPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    authStateCallback = null;
    window.history.pushState(null, "", "/");
  });

  it("shows a verifying state before the recovery session is confirmed", () => {
    renderPage();
    expect(screen.getByText("Verifying your link…")).toBeInTheDocument();
  });

  it("shows the new-password form once PASSWORD_RECOVERY fires", () => {
    renderPage();
    triggerRecovery();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
  });

  it("shows an expired-link message when the URL carries an error", () => {
    renderPage("/reset-password?error_description=Email%20link%20is%20invalid%20or%20has%20expired");
    expect(screen.getByText("Link expired")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === "Email link is invalid or has expired Request a new one from the sign-in page.")
    ).toBeInTheDocument();
  });

  it("shows an expired-link message if no recovery session arrives in time", () => {
    vi.useFakeTimers();
    renderPage();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("Link expired")).toBeInTheDocument();
  });

  it("requires a password of at least 8 characters", () => {
    renderPage();
    triggerRecovery();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByText("Update password"));

    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(mockedUpdateUser).not.toHaveBeenCalled();
  });

  it("requires the confirmation to match", () => {
    renderPage();
    triggerRecovery();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different1" } });
    fireEvent.click(screen.getByText("Update password"));

    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(mockedUpdateUser).not.toHaveBeenCalled();
  });

  it("updates the password, signs the recovery session out, and shows success", async () => {
    mockedUpdateUser.mockResolvedValue({ data: { user: {} }, error: null } as never);
    mockedSignOut.mockResolvedValue({ error: null } as never);
    renderPage();
    triggerRecovery();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByText("Update password"));

    await waitFor(() => expect(mockedUpdateUser).toHaveBeenCalledWith({ password: "longenough1" }));
    await waitFor(() => expect(mockedSignOut).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Password updated")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Go to sign in"));
    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("shows a readable error when updating the password fails", async () => {
    mockedUpdateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "New password should be different from the old password." }
    } as never);
    renderPage();
    triggerRecovery();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByText("Update password"));

    await waitFor(() =>
      expect(screen.getByText("New password should be different from the old password.")).toBeInTheDocument()
    );
    expect(mockedSignOut).not.toHaveBeenCalled();
  });

  it("never renders a raw error object as {}", async () => {
    mockedUpdateUser.mockResolvedValue({ data: { user: null }, error: {} } as never);
    renderPage();
    triggerRecovery();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByText("Update password"));

    await waitFor(() =>
      expect(screen.getByText("Could not update your password. Try again.")).toBeInTheDocument()
    );
    expect(screen.queryByText("{}")).not.toBeInTheDocument();
  });
});
