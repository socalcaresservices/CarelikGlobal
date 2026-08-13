/**
 * Platform Routes (app.ogevia.com/platform/*)
 *
 * These routes are ONLY for platform super-admins who manage Ogevia itself:
 * - Organization registry (+ onboarding a new organization)
 * - Subscriptions & billing (global plan catalog)
 * - System health & feature flags
 * - Support access
 *
 * Platform users should NEVER see:
 * - Clients
 * - Caregivers
 * - Schedules
 * - Credentials
 * - Organization operations
 *
 * Audit logging is NOT here - it moved to tenant-routes.tsx
 * (/org/:orgSlug/audit). It's a per-organization activity trail
 * (list_audit_logs() takes target_organization_id and is gated by that
 * org's own audit.read permission), not a platform-wide event stream -
 * mounting it here was itself an instance of the platform/tenant mixing
 * the Ogevia Architecture Reset corrects everywhere else.
 */

import { Route } from "react-router-dom";
import { OrganizationsPage } from "@/pages/organizations-page";
import { SubscriptionsPage } from "@/pages/subscriptions-page";
import { FeatureFlagsPage } from "@/pages/feature-flags-page";
import { AddOrganizationPage } from "@/pages/add-organization-page";

/**
 * Platform route definitions
 * Wrapped in a function so they can be conditionally rendered in App.tsx
 */
export function getPlatformRoutes() {
  return [
    <Route key="organizations" path="/organizations" element={<OrganizationsPage />} />,
    <Route key="organizations-new" path="/organizations/new" element={<AddOrganizationPage />} />,
    <Route key="subscriptions" path="/subscriptions" element={<SubscriptionsPage />} />,
    <Route key="feature-flags" path="/feature-flags" element={<FeatureFlagsPage />} />
    // TODO: Platform dashboard
    // TODO: Billing page (per-organization billing/support - currently
    // embedded in OrganizationsPage's row-expand; splitting it into its
    // own page needs an organization picker, deferred)
    // TODO: System health
    // TODO: Support access management (same per-org-picker dependency)
  ];
}
