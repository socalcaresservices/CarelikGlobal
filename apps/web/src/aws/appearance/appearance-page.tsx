import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { InfoTip } from "../ui/info-tip";
import { SummarySection } from "../ui/summary-section";
import { actionError } from "../readiness/format";
import {
  ACCENTS, ACCENT_LABEL, ACCENT_RGB, BACKGROUNDS, BACKGROUND_LABEL, BACKGROUND_SWATCH, CHART_LABEL, CHART_TYPES, DENSITIES, DENSITY_LABEL, LAYOUT_LABEL, LAYOUTS, TEXT_LABEL, TEXT_SIZES, rgbCss,
  type PartialAppearance,
} from "./appearance";
import { useAppearanceState, useSaveAppearance } from "./appearance-hooks";

type Key = keyof PartialAppearance;
interface Group { key: Key; legend: string; options: readonly string[]; label: (v: string) => string; swatch?: (v: string) => string; hint?: string }

const GROUPS: Group[] = [
  { key: "background", legend: "Background", options: BACKGROUNDS, label: (v) => BACKGROUND_LABEL[v as keyof typeof BACKGROUND_LABEL], swatch: (v) => BACKGROUND_SWATCH[v as keyof typeof BACKGROUND_SWATCH] },
  { key: "accent", legend: "Accent", options: ACCENTS, label: (v) => ACCENT_LABEL[v as keyof typeof ACCENT_LABEL], swatch: (v) => rgbCss(ACCENT_RGB[v as keyof typeof ACCENT_RGB].light) },
  { key: "density", legend: "Density", options: DENSITIES, label: (v) => DENSITY_LABEL[v as keyof typeof DENSITY_LABEL] },
  { key: "textSize", legend: "Text size", options: TEXT_SIZES, label: (v) => TEXT_LABEL[v as keyof typeof TEXT_LABEL] },
  { key: "layout", legend: "Layout", options: LAYOUTS, label: (v) => LAYOUT_LABEL[v as keyof typeof LAYOUT_LABEL], hint: "Minimal flattens boxes and borders. Nothing is hidden or removed; every alert, action and detail stays on the page." },
  { key: "chartType", legend: "Charts", options: CHART_TYPES, label: (v) => CHART_LABEL[v as keyof typeof CHART_LABEL], hint: "Used where it fits the data: line only for change over time, donut only for parts of a whole. Otherwise bars." },
];

/** One level of choices. "Default" clears the choice so the next level applies. */
function ChoiceForm({ level, current, defaultLabel }: { level: "me" | "organization"; current: PartialAppearance; defaultLabel: string }) {
  const [draft, setDraft] = useState<PartialAppearance>(current);
  const save = useSaveAppearance(level);
  const dirty = GROUPS.some((g) => draft[g.key] !== current[g.key]);
  return (
    <form
      className="space-y-1"
      aria-label={level === "me" ? "My view" : "Agency defaults"}
      onSubmit={(e) => { e.preventDefault(); if (dirty && !save.isPending) save.mutate(draft); }}
    >
      {GROUPS.map((g) => (
        <fieldset key={g.key} className="min-w-0 md:flex md:items-start md:gap-3">
          <legend className="text-sm font-semibold text-og-ink md:float-left md:w-24 md:pt-1">{g.legend}</legend>
          <div className="flex flex-wrap gap-1.5 md:flex-1">
            {[null, ...g.options].map((v) => {
              const selected = (draft[g.key] ?? null) === v;
              return (
                <label key={v ?? "default"} className={"og-row inline-flex min-h-[44px] cursor-pointer md:min-h-[28px] items-center gap-1 rounded-md border px-2 text-sm focus-within:outline focus-within:outline-2 focus-within:outline-og-accent " + (selected ? "border-og-accent bg-og-active font-semibold text-og-ink" : "border-og-line bg-og-card text-og-ink")}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${level}-${g.key}`}
                    checked={selected}
                    onChange={() => setDraft({ ...draft, [g.key]: v } as PartialAppearance)}
                  />
                  {v && g.swatch ? <span aria-hidden="true" className="h-4 w-4 rounded-full border border-og-line" style={{ background: g.swatch(v) }} /> : null}
                  {selected ? <span aria-hidden="true">✓</span> : null}
                  {v === null ? defaultLabel : g.label(v)}
                </label>
              );
            })}
            {g.hint ? <InfoTip label={`About ${g.legend}`} className="self-center">{g.hint}</InfoTip> : null}
          </div>
        </fieldset>
      ))}
      {save.isError ? <p role="alert" className="text-sm text-red-700">{actionError(save.error, "The appearance could not be saved.")}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="min-h-[44px] md:min-h-[32px]" disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        {save.isSuccess && !dirty ? <p role="status" className="text-sm text-og-sub">Saved.</p> : null}
      </div>
    </form>
  );
}

/** Settings > Appearance: each person's own view, and (administrators) the agency defaults. */
export function AppearancePage() {
  const q = useAppearanceState();
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-xl font-bold tracking-tight text-og-ink">Appearance</h1>
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Appearance could not be loaded.")}</p> : null}
      {q.data ? (
        <>
          <Card className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h2 className="text-sm font-semibold text-og-ink">My view</h2>
              <p className="text-xs text-og-sub">Only you see these. “Agency default” follows your agency&apos;s setting.</p>
            </div>
            <ChoiceForm key={JSON.stringify(q.data.mine)} level="me" current={q.data.mine} defaultLabel="Agency default" />
          </Card>
          {q.data.canSetOrganizationDefaults ? (
            <SummarySection title="Agency defaults" summary="What everyone sees until they choose their own.">
              <ChoiceForm key={JSON.stringify(q.data.organization)} level="organization" current={q.data.organization} defaultLabel="Built-in" />
            </SummarySection>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
