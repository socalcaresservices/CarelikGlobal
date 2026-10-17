import { useEffect } from "react";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { applyAppearance, clearAppearance, writeCachedAppearance } from "./appearance";
import { useAppearanceState, useEffectiveAppearance } from "./appearance-hooks";

/** Mounted once in the shell: applies the effective choices to <html> and remembers them for the next first paint. */
export function AppearanceApplier() {
  const { user } = useAuth();
  const { activeOrganizationId } = useOrganization();
  const effective = useEffectiveAppearance();
  const loaded = useAppearanceState().data !== undefined;
  useEffect(() => {
    applyAppearance(document.documentElement, effective);
    if (loaded) writeCachedAppearance(user?.id, activeOrganizationId, effective);
  }, [effective, loaded, user?.id, activeOrganizationId]);
  useEffect(() => () => clearAppearance(document.documentElement), []);
  return null;
}

