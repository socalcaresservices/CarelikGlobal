import type { PropsWithChildren } from "react";
import { EnvironmentContext, useEnvironmentMarker, type EnvironmentMarker } from "./environment";

export function EnvironmentProvider({ marker, children }: PropsWithChildren<{ marker: EnvironmentMarker }>) {
  return <EnvironmentContext.Provider value={marker}>{children}</EnvironmentContext.Provider>;
}

/** Visible on every page and on the sign-in screens (and in the phone drawer's page), hidden when printing because reports carry the same text in their own header. Its own band: never part of the "OWNER VIEW" footer. */
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
        "flex min-h-[48px] items-center justify-center gap-2 border-b-4 px-4 py-2 text-center text-base font-extrabold uppercase tracking-wide print:hidden sm:text-lg " +
        (unverified ? "border-slate-950 bg-[#1e293b] text-white" : "border-amber-600 bg-amber-300 text-amber-950")
      }
    >
      <span aria-hidden="true">{unverified ? "?" : "⚠"}</span>
      {marker.label}
    </div>
  );
}
