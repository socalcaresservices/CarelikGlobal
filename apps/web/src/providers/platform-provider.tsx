/**
 * Platform Provider Context
 *
 * For platform.carelik.com only
 * Provides minimal context needed for platform super-admins
 * (mainly organization registry operations)
 *
 * Platform users do NOT have:
 * - Active organization context
 * - Tenant-specific permissions
 * - Branding context
 */

import { createContext, useContext, type PropsWithChildren } from "react";

interface PlatformContextValue {
  isPlatformUser: boolean;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ children }: PropsWithChildren) {
  return (
    <PlatformContext.Provider value={{ isPlatformUser: true }}>
      {children}
    </PlatformContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePlatform() {
  const context = useContext(PlatformContext);
  if (!context) {
    throw new Error("usePlatform must be used within PlatformProvider");
  }
  return context;
}
