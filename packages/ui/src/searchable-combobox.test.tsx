import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchableCombobox } from "./searchable-combobox";

const OPTIONS = [
  { value: "1", label: "Jordan Rivera", description: "Murrieta" },
  { value: "2", label: "Sam Caregiver", description: "Temecula" },
  { value: "3", label: "Alex Aide", description: "Murrieta" }
];

describe("SearchableCombobox", () => {
  it("shows every option on focus and filters as the user types", () => {
    const onChange = vi.fn();
    render(<SearchableCombobox label="Client" value={null} onChange={onChange} options={OPTIONS} />);

    fireEvent.focus(screen.getByLabelText("Client"));
    expect(screen.getByText("Jordan Rivera", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Sam Caregiver", { exact: false })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "sam" } });
    expect(screen.queryByText("Jordan Rivera", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText("Sam Caregiver", { exact: false })).toBeInTheDocument();
  });

  it("selects an option on click and shows it as the value", () => {
    const onChange = vi.fn();
    render(<SearchableCombobox label="Client" value={null} onChange={onChange} options={OPTIONS} />);

    fireEvent.focus(screen.getByLabelText("Client"));
    fireEvent.mouseDown(screen.getByText("Sam Caregiver", { exact: false }));

    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("shows a clear button once a value is selected, and clears on click", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchableCombobox label="Client" value={null} onChange={onChange} options={OPTIONS} />
    );
    rerender(<SearchableCombobox label="Client" value="2" onChange={onChange} options={OPTIONS} />);

    expect(screen.getByLabelText("Client")).toHaveValue("Sam Caregiver");
    fireEvent.click(screen.getByRole("button", { name: "Clear Client" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("supports arrow-key navigation and Enter to select", () => {
    const onChange = vi.fn();
    render(<SearchableCombobox label="Client" value={null} onChange={onChange} options={OPTIONS} />);

    const input = screen.getByLabelText("Client");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("1");
  });

  it("shows a 'No matches' message when nothing matches", () => {
    const onChange = vi.fn();
    render(<SearchableCombobox label="Client" value={null} onChange={onChange} options={OPTIONS} />);

    fireEvent.focus(screen.getByLabelText("Client"));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "zzz" } });

    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("debounces and calls onSearch for server-driven lookups", async () => {
    const onSearch = vi.fn().mockResolvedValue(OPTIONS.slice(0, 1));
    const onChange = vi.fn();
    render(<SearchableCombobox label="Client" value={null} onChange={onChange} onSearch={onSearch} debounceMs={10} />);

    fireEvent.focus(screen.getByLabelText("Client"));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "jordan" } });

    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("jordan"));
    await waitFor(() => expect(screen.getByText("Jordan Rivera", { exact: false })).toBeInTheDocument());
  });
});
