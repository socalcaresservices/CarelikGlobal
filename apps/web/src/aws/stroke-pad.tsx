// A signature pad that records STROKES (pointer positions with times), never an image. 0120: the server draws the picture itself from validated strokes, so a pasted, dropped or
// uploaded picture has no way in: this component has no file input and refuses paste and drop. The server validates the strokes; nothing here is a security boundary on its own.
import { useEffect, useRef, type PointerEvent } from "react";

export interface Strokes { width: number; height: number; strokes: Array<Array<[number, number, number]>> }
export const PAD_WIDTH = 600;
export const PAD_HEIGHT = 200;

export function StrokePad({ onChange, label = "Signature" }: { onChange: (strokes: Strokes | null) => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Strokes["strokes"]>([]);
  const current = useRef<Array<[number, number, number]> | null>(null);
  const origin = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext?.("2d");
    if (!canvas || !context) return;
    canvas.width = PAD_WIDTH * 2; canvas.height = PAD_HEIGHT * 2;
    context.scale(2, 2);
    context.lineWidth = 3; context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#1e1b4b";
  }, []);

  const at = (event: PointerEvent<HTMLCanvasElement>): [number, number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(PAD_WIDTH, Math.max(0, ((event.clientX - box.left) / Math.max(1, box.width)) * PAD_WIDTH));
    const y = Math.min(PAD_HEIGHT, Math.max(0, ((event.clientY - box.top) / Math.max(1, box.height)) * PAD_HEIGHT));
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(performance.now() - origin.current)];
  };
  function down(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (strokes.current.length === 0 && !current.current) origin.current = performance.now();
    const p = at(event); current.current = [p];
    const c = event.currentTarget.getContext("2d"); c?.beginPath(); c?.moveTo(p[0], p[1]);
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!current.current) return;
    const p = at(event); current.current.push(p);
    const c = event.currentTarget.getContext("2d"); c?.lineTo(p[0], p[1]); c?.stroke();
  }
  function up() {
    const done = current.current; current.current = null;
    if (!done || done.length < 2) return;
    strokes.current.push(done);
    onChange({ width: PAD_WIDTH, height: PAD_HEIGHT, strokes: strokes.current.map((s) => s.map((p) => [...p] as [number, number, number])) });
  }
  function clear() {
    const canvas = ref.current; const c = canvas?.getContext("2d");
    if (canvas && c) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height); c.restore(); }
    strokes.current = []; current.current = null; onChange(null);
  }
  const refuse = (event: { preventDefault(): void }) => event.preventDefault();
  return (
    <div>
      <div className="overflow-hidden rounded-2xl border-2 border-slate-300 bg-white">
        <canvas ref={ref} aria-label={label} data-testid="stroke-pad" className="block w-full touch-none select-none" style={{ aspectRatio: `${PAD_WIDTH} / ${PAD_HEIGHT}` }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onPaste={refuse} onDrop={refuse} onDragOver={refuse} onContextMenu={refuse} />
      </div>
      <button type="button" onClick={clear} className="mt-2 min-h-11 text-sm font-semibold text-slate-600 underline underline-offset-2">Clear signature</button>
    </div>
  );
}
