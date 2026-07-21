import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResponsiveDataView } from "./responsive-data-view";

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [
  { id: "1", name: "Jordan Rivera" },
  { id: "2", name: "Alex Aide" }
];

describe("ResponsiveDataView", () => {
  it("shows the empty message when there are no rows", () => {
    render(
      <ResponsiveDataView<Row>
        rows={[]}
        rowKey={(row) => row.id}
        renderTable={() => <table />}
        renderCard={(row) => <p>{row.name}</p>}
        emptyMessage="No clients yet."
      />
    );
    expect(screen.getByText("No clients yet.")).toBeInTheDocument();
  });

  it("renders both the table and card views from the same rows", () => {
    render(
      <ResponsiveDataView<Row>
        rows={ROWS}
        rowKey={(row) => row.id}
        renderTable={(rows) => (
          <table>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        renderCard={(row) => <p>{row.name} card</p>}
      />
    );
    expect(screen.getAllByText("Jordan Rivera").length).toBeGreaterThan(0);
    expect(screen.getByText("Jordan Rivera card")).toBeInTheDocument();
  });
});
