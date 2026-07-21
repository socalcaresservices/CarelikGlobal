import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiSelectCombobox } from "./multi-select-combobox";

const OPTIONS = [
  { value: "personal-care", label: "Personal care" },
  { value: "companionship", label: "Companionship" },
  { value: "medication-mgmt", label: "Medication management" }
];

describe("MultiSelectCombobox", () => {
  it("shows currently selected values as removable chips", () => {
    render(
      <MultiSelectCombobox label="Services" values={["personal-care"]} onChange={vi.fn()} options={OPTIONS} />
    );
    expect(screen.getByText("Personal care")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Personal care" })).toBeInTheDocument();
  });

  it("adds a service on selection", () => {
    const onChange = vi.fn();
    render(<MultiSelectCombobox label="Services" values={[]} onChange={onChange} options={OPTIONS} />);

    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.mouseDown(screen.getByText("Companionship"));

    expect(onChange).toHaveBeenCalledWith(["companionship"]);
  });

  it("removes a chip when its remove button is clicked", () => {
    const onChange = vi.fn();
    render(
      <MultiSelectCombobox
        label="Services"
        values={["personal-care", "companionship"]}
        onChange={onChange}
        options={OPTIONS}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Personal care" }));
    expect(onChange).toHaveBeenCalledWith(["companionship"]);
  });

  it("excludes already-selected values from the dropdown results", () => {
    render(
      <MultiSelectCombobox label="Services" values={["personal-care"]} onChange={vi.fn()} options={OPTIONS} />
    );

    fireEvent.focus(screen.getByRole("combobox"));

    // "Personal care" still appears once, as the chip - not a second time in the list.
    expect(screen.getAllByText("Personal care")).toHaveLength(1);
    expect(screen.getByText("Companionship")).toBeInTheDocument();
  });

  it("removes the last chip on backspace when the query is empty", () => {
    const onChange = vi.fn();
    render(
      <MultiSelectCombobox label="Services" values={["personal-care", "companionship"]} onChange={onChange} options={OPTIONS} />
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith(["personal-care"]);
  });
});
