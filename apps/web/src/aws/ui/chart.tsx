import { resolveChart, type ChartType, type DataShape } from "../appearance/appearance";
import { useEffectiveAppearance } from "../appearance/appearance-hooks";

export interface ChartDatum { label: string; value: number; display: string }

const PALETTE = ["rgb(var(--og-accent))", "rgb(var(--og-chart-2))", "rgb(var(--og-chart-3))", "rgb(var(--og-chart-4))", "rgb(var(--og-chart-5))"];

/**
 * A chart that follows the person's chart preference only where that type is honest for the data (resolveChart). It always
 * keeps the labels, the units and a total, and an accessible table lists exactly the values drawn.
 */
export function Chart({ title, data, shape, unit, total }: { title: string; data: ChartDatum[]; shape: DataShape; unit: string; total: string }) {
  const { chartType } = useEffectiveAppearance();
  const { kind, note } = resolveChart(chartType as ChartType, shape);
  const max = Math.max(1, ...data.map((d) => d.value));
  const sum = data.reduce((t, d) => t + d.value, 0);
  return (
    <figure className="space-y-2" aria-label={title} data-chart-kind={kind}>
      {kind === "donut" ? <Donut data={data} sum={sum} /> : <Bars data={data} max={max} />}
      <figcaption className="text-xs text-og-sub">
        Total {total} {unit}
        {note ? <span className="ml-2" data-testid="chart-note">{note}</span> : null}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">{unit}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.label}><th scope="row">{d.label}</th><td>{d.display}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Bars are categories, not statuses: one calm accent colour, so colour never suggests a warning. */
function Bars({ data, max }: { data: ChartDatum[]; max: number }) {
  return (
    <ul className="space-y-2" aria-hidden="true">
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
          <span className="truncate text-og-ink">{d.label}</span>
          <span className="h-3 overflow-hidden rounded-full bg-og-line">
            <span className="block h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: PALETTE[0] }} />
          </span>
          <span className="font-og-mono text-xs tabular-nums text-og-ink">{d.display}</span>
        </li>
      ))}
    </ul>
  );
}

function Donut({ data, sum }: { data: ChartDatum[]; sum: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-4" aria-hidden="true">
      <svg viewBox="0 0 100 100" className="h-32 w-32 shrink-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(var(--og-line))" strokeWidth="14" />
        {sum > 0 ? data.map((d, i) => {
          const len = (d.value / sum) * c;
          const el = <circle key={d.label} cx="50" cy="50" r={r} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="14" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        }) : null}
      </svg>
      <ul className="space-y-1 text-sm">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="text-og-ink">{d.label}</span>
            <span className="font-og-mono text-xs tabular-nums text-og-sub">{d.display}{sum > 0 ? ` · ${Math.round((d.value / sum) * 100)}%` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
