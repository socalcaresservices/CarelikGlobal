import type { PropsWithChildren } from "react";
import { EnvironmentContext, useEnvironmentMarker, type EnvironmentMarker } from "./environment";

export function EnvironmentProvider({ marker, children }: PropsWithChildren<{ marker: EnvironmentMarker }>) {
  return <EnvironmentContext.Provider value={marker}>{children}</EnvironmentContext.Provider>;
}

/** Visible on every page (and in the phone drawer's page), hidden when printing because reports carry the same text in their own header. */
export function EnvironmentBanner() {
  const marker = useEnvironmentMarker();
  if (!marker?.label) return null;
  const unverified = marker.kind === "unverified";
  return (
    <div
      role="region"
      aria-label="Environment"
      data-testid="environment-banner"
      data-environment={marker.kind}
      className={
        "flex min-h-[36px] items-center justify-center gap-2 px-4 py-1.5 text-center text-sm font-bold tracking-wide print:hidden " +
        (unverified ? "bg-[#1e293b] text-white" : "bg-amber-300 text-amber-950")
      }
    >
      <span aria-hidden="true">{unverified ? "?" : "⚠"}</span>
      {marker.label}
    </div>
  );
}
