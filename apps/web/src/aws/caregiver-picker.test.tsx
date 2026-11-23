import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaregiverPicker } from "./caregiver-picker";
import { FILTER_AFTER, sortCaregivers } from "./caregiver-order";

const cg = (n: number, firstName: string, lastName: string, extra: Record<string, unknown> = {}) => ({
  caregiverRecordId: `r${n}`, firstName, lastName, preferredName: null, caregiverCode: `CG-${String(n).padStart(3, "0")}`, ...extra,
});
const optionNames = () => within(screen.getByRole("combobox", { name: "Caregiver" })).getAllByRole("option").map((o) => o.textContent);

function renderPicker(caregivers: ReturnType<typeof cg>[], props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(<CaregiverPicker id="p" label="Caregiver" value="" onChange={onChange} caregivers={caregivers as never} placeholder="Choose a caregiver" {...props} />);
  return onChange;
}

describe("CaregiverPicker", () => {
  it("lists caregivers A-Z by last then first name, after the empty choice, whatever order the server sent", () => {
    renderPicker([cg(1, "Mia", "Lopez"), cg(2, "Zed", "Park"), cg(3, "Amy", "Chen"), cg(4, "Bea", "Chen")]);
    expect(optionNames()).toEqual(["Choose a caregiver", "Amy Chen", "Bea Chen", "Mia Lopez", "Zed Park"]);
  });

  it("adds the code only to a name another record shares, and appends the caller's suffix", () => {
    renderPicker([cg(1, "Sam", "Lee", { duplicateName: true }), cg(2, "Sam", "Lee", { duplicateName: true, hasSignIn: false }), cg(3, "Kim", "Ng")], {
      suffix: (c: { hasSignIn?: boolean }) => (c.hasSignIn === false ? " — planned: no sign-in yet" : ""),
    });
    expect(optionNames()).toEqual(["Choose a caregiver", "Sam Lee (CG-001)", "Sam Lee (CG-002) — planned: no sign-in yet", "Kim Ng"]);
  });

  it("reports the chosen caregiver record id, and the empty choice as an empty string", () => {
    const onChange = renderPicker([cg(1, "Mia", "Lopez"), cg(2, "Amy", "Chen")]);
    fireEvent.change(screen.getByRole("combobox", { name: "Caregiver" }), { target: { value: "r2" } });
    expect(onChange).toHaveBeenLastCalledWith("r2");
    fireEvent.change(screen.getByRole("combobox", { name: "Caregiver" }), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows no find box for a short list, and a find box that narrows a long list by name or code", () => {
    const short = Array.from({ length: FILTER_AFTER }, (_, i) => cg(i + 1, `First${i}`, `Last${i}`));
    const { unmount } = render(<CaregiverPicker id="p" label="Caregiver" value="" onChange={() => {}} caregivers={short as never} placeholder="Choose" />);
    expect(screen.queryByRole("searchbox", { name: "Find a caregiver" })).toBeNull();
    unmount();
    const long = Array.from({ length: FILTER_AFTER + 1 }, (_, i) => cg(i + 1, `First${i}`, `Last${i}`));
    renderPicker(long);
    const find = screen.getByRole("searchbox", { name: "Find a caregiver" });
    fireEvent.change(find, { target: { value: "last3" } });
    expect(optionNames()).toEqual(["Choose a caregiver", "First3 Last3"]);
    fireEvent.change(find, { target: { value: "cg-007" } });
    expect(optionNames()).toEqual(["Choose a caregiver", "First6 Last6"]);
    fireEvent.change(find, { target: { value: "nobody" } });
    expect(optionNames()).toEqual(["Choose a caregiver"]);
    expect(screen.getByRole("status")).toHaveTextContent("No caregiver matches that search.");
  });

  it("keeps the chosen caregiver in the list while the search narrows it", () => {
    const long = Array.from({ length: FILTER_AFTER + 1 }, (_, i) => cg(i + 1, `First${i}`, `Last${i}`));
    render(<CaregiverPicker id="p" label="Caregiver" value="r5" onChange={() => {}} caregivers={long as never} placeholder="Choose" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a caregiver" }), { target: { value: "last0" } });
    expect(optionNames()).toEqual(["Choose", "First0 Last0", "First4 Last4"]);
  });

  it("sortCaregivers is stable, keeps equal names in input order and does not change its input", () => {
    const input = [{ firstName: "A", lastName: "B", tag: 1 }, { firstName: "A", lastName: "B", tag: 2 }];
    const copy = [...input];
    expect(sortCaregivers(input).map((x) => x.tag)).toEqual([1, 2]);
    expect(input).toEqual(copy);
    expect(sortCaregivers([])).toEqual([]);
  });
});
