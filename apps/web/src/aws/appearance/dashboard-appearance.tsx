import { useDashboardAppearance, DASHBOARD_PALETTES, type DashboardChartStyle, type DashboardPalette } from "./appearance-hooks";

export function DashboardAppearanceControls() {
  const { chartStyle, palette, chooseStyle, choosePalette, colors } = useDashboardAppearance();
  const input = "mt-1 block w-full rounded-md border border-og-line bg-og-card px-2 py-2 text-sm";
  return <section className="space-y-2 rounded-og border border-og-line bg-og-card p-3" aria-label="Dashboard charts">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Dashboard charts</h2><button type="button" className="text-sm text-og-link underline" onClick={() => { chooseStyle("treemap"); choosePalette("care"); }}>Reset chart defaults</button></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm font-medium">Style
        <select className={input} value={chartStyle} onChange={(event) => chooseStyle(event.target.value as DashboardChartStyle)}>
          <option value="current">Current layout</option><option value="pie">Pie</option>
          <option value="bar">Bar</option><option value="treemap">Treemap</option>
        </select>
      </label>
      <label className="text-sm font-medium">Colors
        <select className={input} value={palette} onChange={(event) => choosePalette(event.target.value as DashboardPalette)}>
          {Object.entries(DASHBOARD_PALETTES).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
        </select>
      </label>
    </div>
    <div className="flex w-fit overflow-hidden rounded-full ring-1 ring-og-line" aria-hidden="true">{colors.map((color) =>
      <span key={color} className="h-3 w-9" style={{ backgroundColor: color }} />)}</div>
  </section>;
}
