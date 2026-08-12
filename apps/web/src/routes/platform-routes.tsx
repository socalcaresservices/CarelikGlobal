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
import { OrganizationsPage } from "@/pages/organizations-page";
import { SubscriptionsPage } from "@/pages/subscriptions-page";
import { FeatureFlagsPage } from "@/pages/feature-flags-page";
import { AuditPage } from "@/pages/audit-page";

/**
 * Platform route definitions
 * Wrapped in a function so they can be conditionally rendered in App.tsx
 */
export function getPlatformRoutes() {
  return [
    <Route key="organizations" path="/organizations" element={<OrganizationsPage />} />,
    <Route key="subscriptions" path="/subscriptions" element={<SubscriptionsPage />} />,
    <Route key="feature-flags" path="/feature-flags" element={<FeatureFlagsPage />} />,
    <Route key="audit" path="/audit" element={<AuditPage />} />
    // TODO: Platform dashboard
    // TODO: Billing page (per-organization billing/support - currently
    // embedded in OrganizationsPage's row-expand; splitting it into its
    // own page needs an organization picker, deferred)
    // TODO: System health
    // TODO: Support access management (same per-org-picker dependency)
  ];
}
