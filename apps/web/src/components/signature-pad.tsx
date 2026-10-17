// Finger/stylus signature capture, shared by the caregiver visit screen and the
// recipient's late-confirmation page. Produces a PNG data URL; never logged.
import { useEffect, useRef, type PointerEvent } from "react";

export function SignaturePad({
  onChange,
  label = "Client or guardian signature",
}: {
  onChange: (dataUrl: string | null) => void;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
    canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
    const context = canvas.getContext("2d");
    context?.scale(ratio, ratio);
    if (context) {
      context.lineWidth = 3;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#312e81";
    }
  }, []);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const context = event.currentTarget.getContext("2d");
    const next = point(event);
    context?.beginPath();
    context?.moveTo(next.x, next.y);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    const next = point(event);
    context?.lineTo(next.x, next.y);
    context?.stroke();
    hasInk.current = true;
  }

  function stop(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasInk.current) onChange(event.currentTarget.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    onChange(null);
  }

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border-2 border-slate-300 bg-og-card focus-within:border-[var(--color-accent,#4f46e5)]">
        <canvas
          ref={canvasRef}
          aria-label={label}
          className="block h-40 w-full touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <button
        type="button"
        onClick={clear}
        className="mt-2 min-h-11 text-sm font-semibold text-slate-600 underline underline-offset-2"
      >
        Clear signature
      </button>
    </div>
  );
}
