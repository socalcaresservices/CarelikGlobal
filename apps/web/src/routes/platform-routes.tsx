/**
 * Platform Routes (carelik.com/platform.carelik.com)
 *
 * These routes are ONLY for platform super-admins who manage Ogevia itself:
 * - Organization registry
 * - Subscriptions & billing
 * - Platform analytics
 * - System health & feature flags
 * - Audit logging
 * - Support access
 *
 * Platform users should NEVER see:
 * - Clients
 * - Caregivers
 * - Schedules
 * - Credentials
 * - Organization operations
 */

import { Route } from "react-router-dom";
import { PlatformDashboardPage } from "@/pages/platform-dashboard-page";
import { OrganizationsPage } from "@/pages/organizations-page";
import { FeatureFlagsPage } from "@/pages/feature-flags-page";
import { AuditPage } from "@/pages/audit-page";
import { SystemHealthPage } from "@/pages/system-health-page";
import { SupportAuditPage } from "@/pages/support-audit-page";

/**
 * Platform route definitions
 * Wrapped in a function so they can be conditionally rendered in App.tsx
 */
export function getPlatformRoutes() {
  return [
    <Route key="dashboard" path="/" element={<PlatformDashboardPage />} />,
    <Route key="organizations" path="/organizations" element={<OrganizationsPage />} />,
    <Route key="feature-flags" path="/feature-flags" element={<FeatureFlagsPage />} />,
    <Route key="audit" path="/audit" element={<AuditPage />} />,
    <Route key="support-audit" path="/support-audit" element={<SupportAuditPage />} />,
    <Route key="system-health" path="/system-health" element={<SystemHealthPage />} />
    // Subscriptions & billing and support access already live inside
    // Organizations (PlatformPlanManager / PlatformSubscriberBillingPanel /
    // SupportAccessPanel), not as separate top-level pages.
  ];
}
