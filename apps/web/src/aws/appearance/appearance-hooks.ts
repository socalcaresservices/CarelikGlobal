import { useState } from "react";

export type DashboardChartStyle = "current" | "pie" | "bar" | "treemap";
export const DASHBOARD_PALETTES = {
  care: { name: "Care blue", colors: ["#235AE7", "#14B8A6", "#73A9FF", "#182B54"] },
  mono: { name: "Blue shades", colors: ["#244986", "#3B72BB", "#68A4E8", "#A7CEF5"] },
} as const;
export type DashboardPalette = keyof typeof DASHBOARD_PALETTES;
const styleKey = "ogevia.dashboard.chartStyle";
const paletteKey = "ogevia.dashboard.palette";

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function useDashboardAppearance() {
  const [chartStyle, setChartStyle] = useState<DashboardChartStyle>(() => {
    const saved = read(styleKey);
    if (saved === "dot") return "treemap";
    return saved === "current" || saved === "pie" || saved === "bar" ? saved : "treemap";
  });
  const [palette, setPalette] = useState<DashboardPalette>(() => {
    const saved = read(paletteKey);
    return saved === "mono" ? saved : "care";
  });
  function chooseStyle(value: DashboardChartStyle) {
    setChartStyle(value);
    try { localStorage.setItem(styleKey, value); } catch { /* Browser storage is optional. */ }
  }
  function choosePalette(value: DashboardPalette) {
    setPalette(value);
    try { localStorage.setItem(paletteKey, value); } catch { /* Browser storage is optional. */ }
  }
  return { chartStyle, palette, chooseStyle, choosePalette, colors: DASHBOARD_PALETTES[palette].colors };
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { readCachedAppearance, SYSTEM_DEFAULTS, toEffective, type AppearanceState, type EffectiveAppearance, type PartialAppearance } from "./appearance";

export function useAppearanceState() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["appearance", activeOrganizationId],
    queryFn: async () => (await api.get<{ appearance: AppearanceState }>("/v1/appearance", { organizationId: activeOrganizationId })).appearance,
    enabled: !!activeOrganizationId,
    staleTime: 5 * 60_000,
  });
}

/** The choices in force for this person right now (their own, else the agency's, else the built-in defaults). */
export function useEffectiveAppearance(): EffectiveAppearance {
  const { user } = useAuth();
  const { activeOrganizationId } = useOrganization();
  const q = useAppearanceState();
  return q.data ? toEffective(q.data) : readCachedAppearance(user?.id, activeOrganizationId) ?? SYSTEM_DEFAULTS;
}

/** Mounted once in the shell: applies the effective choices to <html> and remembers them for the next first paint. */
type Level = "organization" | "me";
export function useSaveAppearance(level: Level) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (choices: PartialAppearance) =>
      (await api.post<{ appearance: AppearanceState }>(level === "organization" ? "/v1/appearance/organization" : "/v1/appearance/me", { organizationId: activeOrganizationId, ...choices })).appearance,
    onSuccess: (appearance) => {
      queryClient.setQueryData(["appearance", activeOrganizationId], appearance);
    },
  });
}
