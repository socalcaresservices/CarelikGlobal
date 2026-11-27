// 0124: the signature pad records strokes and offers no way to bring in a picture. SYNTHETIC only.
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAD_HEIGHT, PAD_WIDTH, StrokePad, type Strokes } from "./stroke-pad";

afterEach(cleanup);
// jsdom has no PointerEvent: without it fireEvent drops clientX/clientY and the pad would record NaN.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {}, setTransform() {}, clearRect() {} })) as never;

function pad() {
  const seen: Array<Strokes | null> = [];
  const { container } = render(<StrokePad onChange={(s) => seen.push(s)} />);
  const canvas = screen.getByTestId("stroke-pad");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0, toJSON() {} });
  return { seen, canvas, container };
}
const draw = (canvas: HTMLElement, points: Array<[number, number]>) => {
  fireEvent.pointerDown(canvas, { clientX: points[0]![0], clientY: points[0]![1], pointerId: 1 });
  for (const [x, y] of points.slice(1)) fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
};

describe("stroke pad", () => {
  it("reports strokes with positions scaled to the pad size and increasing times, never an image", () => {
    const { seen, canvas } = pad();
    draw(canvas, [[10, 10], [60, 40], [120, 20]]);
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ width: PAD_WIDTH, height: PAD_HEIGHT });
    expect(last.strokes).toHaveLength(1);
    expect(last.strokes[0]).toHaveLength(3);
    expect(last.strokes[0]![1]![0]).toBeCloseTo(120, 0);          // 60 px of a 300 px wide pad = 120 of 600
    expect(last.strokes[0]![1]![1]).toBeCloseTo(80, 0);           // 40 px of a 100 px tall pad = 80 of 200
    const times = last.strokes[0]!.map((p) => p[2]);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(JSON.stringify(last)).not.toMatch(/data:image|base64/);
  });
  it("a second stroke is added, a tap is ignored, and Clear removes everything", () => {
    const { seen, canvas } = pad();
    draw(canvas, [[5, 5], [50, 30]]);
    fireEvent.pointerDown(canvas, { clientX: 9, clientY: 9, pointerId: 1 }); fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(seen.at(-1)!.strokes).toHaveLength(1);
    draw(canvas, [[70, 10], [90, 80]]);
    expect(seen.at(-1)!.strokes).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /clear signature/i }));
    expect(seen.at(-1)).toBeNull();
  });
  it("refuses paste, drop and the context menu, and has no file input", () => {
    const { canvas, container } = pad();
    for (const make of [() => createEvent.paste(canvas), () => createEvent.drop(canvas), () => createEvent.contextMenu(canvas)]) {
      const event = make(); fireEvent(canvas, event); expect(event.defaultPrevented).toBe(true);
    }
    expect(container.querySelector("input[type=file]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
