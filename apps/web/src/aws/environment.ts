import { createContext, useContext } from "react";

/**
 * The environment this build runs in, from EXPLICIT configuration only (the deployment's /config.json, or the
 * build's VITE_APP_ENV as a fallback). Nothing is guessed from the address, the data or the host name.
 *
 *   test               -> "TEST — synthetic data only"
 *   demo               -> "DEMO — synthetic data only"
 *   development        -> "DEV — synthetic data only"
 *   production          -> no banner
 *   missing or invalid  -> "Environment not verified" (never labelled TEST: an unknown environment is unknown)
 */
export type EnvironmentKind = "test" | "demo" | "development" | "production" | "unverified";

export interface EnvironmentMarker {
  kind: EnvironmentKind;
  /** The banner text, or null when nothing should be shown (production). */
  label: string | null;
}

export const TEST_MARKER_LABEL = "TEST — synthetic data only";
export const UNVERIFIED_MARKER_LABEL = "Environment not verified";

export function resolveEnvironmentMarker(value: unknown): EnvironmentMarker {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "test") return { kind: v, label: TEST_MARKER_LABEL };
  if (v === "demo") return { kind: v, label: "DEMO — synthetic data only" };
  if (v === "development") return { kind: v, label: "DEV — synthetic data only" };
  if (v === "production") return { kind: "production", label: null };
  return { kind: "unverified", label: UNVERIFIED_MARKER_LABEL };
}

// null = no environment context at all (for example the older non-AWS build): show nothing, claim nothing.
export const EnvironmentContext = createContext<EnvironmentMarker | null>(null);

export function useEnvironmentMarker(): EnvironmentMarker | null {
  return useContext(EnvironmentContext);
}
