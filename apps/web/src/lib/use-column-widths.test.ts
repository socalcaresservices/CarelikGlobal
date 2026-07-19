import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useColumnWidths } from "./use-column-widths";

const STORAGE_KEY = "carelik:column-widths:test";

function fireMouseEvent(type: "mousemove" | "mouseup", clientX: number) {
  const event = new MouseEvent(type, { clientX, bubbles: true });
  document.dispatchEvent(event);
}

afterEach(() => {
  window.localStorage.clear();
});

describe("useColumnWidths", () => {
  it("starts from the provided defaults when nothing is stored", () => {
    const { result } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 200, status: 120 }));
    expect(result.current.widths).toEqual({ name: 200, status: 120 });
  });

  it("widens a column as the pointer drags right", () => {
    const { result } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 200, status: 120 }));

    act(() => {
      result.current.startResize("name")({
        preventDefault: () => {},
        clientX: 100
      } as unknown as React.MouseEvent<HTMLDivElement>);
    });
    act(() => fireMouseEvent("mousemove", 150));
    act(() => fireMouseEvent("mouseup", 150));

    expect(result.current.widths.name).toBe(250);
    expect(result.current.widths.status).toBe(120);
  });

  it("never resizes a column narrower than the minimum width", () => {
    const { result } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 80, status: 120 }));

    act(() => {
      result.current.startResize("name")({
        preventDefault: () => {},
        clientX: 100
      } as unknown as React.MouseEvent<HTMLDivElement>);
    });
    act(() => fireMouseEvent("mousemove", -500));
    act(() => fireMouseEvent("mouseup", -500));

    expect(result.current.widths.name).toBe(60);
  });

  it("stops resizing once the mouse is released", () => {
    const { result } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 200, status: 120 }));

    act(() => {
      result.current.startResize("name")({
        preventDefault: () => {},
        clientX: 100
      } as unknown as React.MouseEvent<HTMLDivElement>);
    });
    act(() => fireMouseEvent("mousemove", 150));
    act(() => fireMouseEvent("mouseup", 150));
    act(() => fireMouseEvent("mousemove", 400));

    expect(result.current.widths.name).toBe(250);
  });

  it("persists widths to localStorage and restores them for the same key", () => {
    const { result, unmount } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 200 }));

    act(() => {
      result.current.startResize("name")({
        preventDefault: () => {},
        clientX: 0
      } as unknown as React.MouseEvent<HTMLDivElement>);
    });
    act(() => fireMouseEvent("mousemove", 60));
    act(() => fireMouseEvent("mouseup", 60));
    expect(result.current.widths.name).toBe(260);
    unmount();

    const { result: reloaded } = renderHook(() => useColumnWidths(STORAGE_KEY, { name: 200 }));
    expect(reloaded.current.widths.name).toBe(260);
  });

  it("keeps each storage key's widths independent", () => {
    const { result: a } = renderHook(() => useColumnWidths("carelik:column-widths:table-a", { name: 200 }));
    const { result: b } = renderHook(() => useColumnWidths("carelik:column-widths:table-b", { name: 200 }));

    act(() => {
      a.current.startResize("name")({
        preventDefault: () => {},
        clientX: 0
      } as unknown as React.MouseEvent<HTMLDivElement>);
    });
    act(() => fireMouseEvent("mousemove", 90));
    act(() => fireMouseEvent("mouseup", 90));

    expect(a.current.widths.name).toBe(290);
    expect(b.current.widths.name).toBe(200);
  });
});
