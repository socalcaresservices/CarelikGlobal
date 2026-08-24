import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface SupportRequest {
  id: string;
  subject: string;
  description: string | null;
  status: "open" | "in_review" | "resolved" | "closed";
  created_by_email: string;
  created_at: string;
}

export interface SupportAccessGrant {
  id: string;
  grantee_email: string;
  access_level: "read_only" | "edit";
  status: "pending_approval" | "active" | "revoked" | "expired";
  expires_at: string | null;
  reason: string;
  requested_at: string;
  approved_at: string | null;
  emergency: boolean;
}

export interface SupportAccessAuditEntry {
  id: string;
  event_type: "login" | "write" | "revoke" | "expire" | "emergency";
  resource_type: string | null;
  action: "INSERT" | "UPDATE" | "DELETE" | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

/**
 * List support requests for the current organization
 */
export function useSupportRequests(organizationId: string | null) {
  return useQuery({
    queryKey: ["support-requests", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const { data, error } = await supabase.rpc("list_support_requests", {
        target_organization_id: organizationId,
        result_limit: 100,
      });

      if (error) throw error;
      return (data ?? []) as SupportRequest[];
    },
    enabled: !!organizationId,
  });
}

/**
 * Create a new support request
 */
export function useCreateSupportRequest(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      subject,
      description,
    }: {
      subject: string;
      description: string;
    }) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data, error } = await supabase.rpc("create_support_request", {
        target_organization_id: organizationId,
        request_subject: subject,
        request_description: description,
      });

      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-requests", organizationId] });
    },
  });
}

/**
 * List active and pending support access grants for the current organization
 */
export function useSupportAccessGrants(organizationId: string | null) {
  return useQuery({
    queryKey: ["support-access-grants", organizationId],
    queryFn: async () => {
      if (!organizationId) return [];

      const { data, error } = await supabase.rpc("list_support_access_grants_new", {
        target_organization_id: organizationId,
        result_limit: 100,
      });

      if (error) throw error;
      return (data ?? []) as SupportAccessGrant[];
    },
    enabled: !!organizationId,
  });
}

/**
 * Get the currently active support grant for this organization (if any)
 */
export function useActiveSupportGrant(organizationId: string | null) {
  const { data: grants } = useSupportAccessGrants(organizationId);

  return {
    grant: grants?.find((g) => g.status === "active"),
    isLoading: !grants,
  };
}

/**
 * Approve a pending support access request
 */
export function useApproveSupportAccess(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      grantId,
      expiresInMinutes,
    }: {
      grantId: string;
      expiresInMinutes?: number;
    }) => {
      const { data, error } = await supabase.rpc("approve_support_access_new", {
        grant_id: grantId,
        expires_in_minutes: expiresInMinutes,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-access-grants", organizationId] });
    },
  });
}

/**
 * Reject a pending support access request
 */
export function useRejectSupportAccess(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (grantId: string) => {
      const { data, error } = await supabase.rpc("reject_support_access", {
        grant_id: grantId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-access-grants", organizationId] });
    },
  });
}

/**
 * Revoke an active support access grant
 */
export function useRevokeSupportAccess(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (grantId: string) => {
      const { data, error } = await supabase.rpc("revoke_support_access_new", {
        grant_id: grantId,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-access-grants", organizationId] });
    },
  });
}

/**
 * Get audit log for a specific support access grant
 */
export function useSupportAccessAudit(grantId: string | null) {
  return useQuery({
    queryKey: ["support-access-audit", grantId],
    queryFn: async () => {
      if (!grantId) return [];

      const { data, error } = await supabase.rpc("get_support_access_audit", {
        grant_id: grantId,
        result_limit: 100,
      });

      if (error) throw error;
      return (data ?? []) as SupportAccessAuditEntry[];
    },
    enabled: !!grantId,
  });
}

// Support Staff Hooks

export interface StaffSupportRequest extends SupportRequest {
  organization_id: string;
  organization_name: string;
}

export interface StaffSupportGrant extends SupportAccessGrant {
  organization_id: string;
  organization_name: string;
}

/**
 * List all open support requests (for support staff)
 */
export function useSupportRequestsForStaff() {
  return useQuery({
    queryKey: ["support-requests-for-staff"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_support_requests_for_staff", {
        result_limit: 100,
      });

      if (error) throw error;
      return (data ?? []) as StaffSupportRequest[];
    },
  });
}

/**
 * List all active support grants for the current staff member (across all organizations)
 */
export function useStaffActiveGrants() {
  return useQuery({
    queryKey: ["staff-active-grants"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_staff_active_grants", {
        result_limit: 100,
      });

      if (error) throw error;
      return (data ?? []) as StaffSupportGrant[];
    },
  });
}

/**
 * Request support access to an organization
 */
export function useRequestSupportAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      requestId,
      organizationId,
      accessLevel,
      reason,
    }: {
      requestId: string;
      organizationId: string;
      accessLevel: "read_only" | "edit";
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("request_support_access_new", {
        support_request_id: requestId,
        target_organization_id: organizationId,
        requested_access_level: accessLevel,
        access_reason: reason,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-requests-for-staff"] });
      queryClient.invalidateQueries({ queryKey: ["staff-active-grants"] });
    },
  });
}

// Emergency Access Hooks

export interface Organization {
  id: string;
  display_name: string;
  slug: string;
}

/**
 * Grant emergency access to an organization (admin only)
 */
export function useGrantEmergencyAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      organizationId,
      userId,
      reason,
    }: {
      organizationId: string;
      userId: string;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("grant_emergency_support_access", {
        target_organization_id: organizationId,
        target_user_id: userId,
        emergency_reason: reason,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff-active-grants"] });
      queryClient.invalidateQueries({ queryKey: ["support-access-grants"] });
    },
  });
}
