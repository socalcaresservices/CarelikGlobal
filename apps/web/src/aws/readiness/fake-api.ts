/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies and fixtures are free-form JSON */
// A stateful in-memory fake of the AWS API for the readiness screens' tests. SYNTHETIC data only.
import { vi } from "vitest";

export const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
export const CG = "abababab-0000-4000-8000-000000000001";
export const CG2 = "abababab-0000-4000-8000-000000000002";
export const SVC = "dddddddd-0000-4000-8000-000000000001";
export const CLIENT = "cccccccc-0000-4000-8000-000000000001";
export const REQ = "eeeeeeee-0000-4000-8000-000000000001";
export const SHIFT = "ffffffff-0000-4000-8000-000000000001";

export type Role = "caregiver" | "manager" | "organization_owner";
export const PERMISSIONS: Record<Role, string[]> = {
  caregiver: ["availability.manage_own", "documents.manage_own", "caregiver_services.read_own", "experience.report_own"],
  manager: ["visits.read", "visits.manage", "caregivers.manage", "authorizations.read", "clients.names.read", "shifts.manage", "care_requests.read", "care_requests.manage",
    "documents.read", "documents.manage", "availability.read", "caregiver_services.read", "readiness.read", "matching.read", "matching.manage"],
  organization_owner: ["visits.read", "visits.manage", "caregivers.manage", "authorizations.read", "clients.names.read", "shifts.manage", "care_requests.read", "care_requests.manage",
    "documents.read", "documents.manage", "organization.update", "availability.read", "availability.review", "availability.override", "caregiver_services.read", "caregiver_services.approve",
    "readiness.read", "readiness.manage", "documents.requirements.manage", "caregivers.compliance.manage", "matching.read", "matching.manage"],
};

export interface Call { method: string; path: string; body: any; key: string | null; query: Record<string, string> }
export const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

export interface FakeOptions {
  role: Role;
  /** The listed shift was assigned under a one-shift Administrator availability override. */
  shiftOverride?: boolean;
  /** Routes ("GET /v1/experience/me") that answer 500 this many times before working. */
  failFirst?: Record<string, number>;
  /** Routes whose answer waits for this promise (a slow network). */
  hold?: Record<string, Promise<void>>;
  /** What the caregiver already reported. */
  myExperience?: { tagId: string; label: string; status: string }[];
  availability?: Partial<Record<string, unknown>>;
  failNextRequestWith?: { status: number; code: string; message: string };
  evaluation?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  matches?: Record<string, unknown>;
  documents?: { requirement: string; status: string; validUntil: string | null }[];
  approvals?: Record<string, unknown>[];
  reviewPairs?: Record<string, unknown>[];
  /** 0055: what GET /v1/caregivers/{id}/compliance answers (merged over an eligible caregiver). */
  compliance?: Record<string, any>;
  /** 0055: what GET /v1/compliance/holds answers. */
  holds?: Record<string, any>;
}

export const baseCompliance = (): Record<string, any> => ({
  caregiverRecordId: CG, caregiverStatus: "active", enforcementActive: true, timezone: "America/Los_Angeles", graceDays: 14,
  hireDate: "2026-10-01", dueDate: "2026-10-15", graceEndsAt: "2026-10-16T07:00:00Z", inGrace: false,
  deadlineRule: "Hire date is day 0. The last day is the hire date plus 14 calendar days in the agency time zone (America/Los_Angeles). A hold starts at 00:00 the next day.",
  background: { state: "approved", qualifies: true, status: "completed", result: "approved", evidenceNote: "Confirmed in the agency clearance record", verifiedAt: "2026-10-02T17:00:00Z", verifiedByName: "Synthetic Owner" },
  requirements: [
    { requirement: "cpr", documentStatus: "ok", validUntil: "2027-10-01", documentId: "d1", blocking: false, pending: false, current: true, code: null, message: null, dueDate: null },
    { requirement: "tb", documentStatus: "ok", validUntil: "2027-10-01", documentId: "d2", blocking: false, pending: false, current: true, code: null, message: null, dueDate: null },
  ],
  hold: null, eligible: true, hireDateRequired: false,
});

export const baseAvailability = () => ({
  caregiverRecordId: CG, timezone: "America/Los_Angeles", version: 2, provided: true, asOf: "2026-10-12",
  weekly: [{ weekday: 1, start_local: "08:00", end_local: "20:00" }, { weekday: 3, start_local: "09:00", end_local: "13:00" }],
  upcomingWeekly: [], exceptions: [{ date: "2026-10-20", hours: { source: "date", unavailable: true, windows: [] } }],
  pending: [], recent: [],
});

export const baseReadiness = () => ({
  enforcementActive: false,
  serviceChecks: { label: "Service checks", state: "Off", enabled: false, offHeadline: "Service checks: Off", offMessage: "Caregivers can be assigned without service approval.", action: "Review services" },
  setupGaps: [{ code: "cpr_type_not_set", requirement: "cpr", gap: "type_not_set" }, { code: "tb_policy_not_set", requirement: "tb", gap: "policy_not_set" }],
  setupComplete: false,
  caregivers: { readyOrActive: 4, withDocumentGaps: 3, availabilityNotProvided: 2, servicePairsToReview: 5 },
  futureWork: { scheduledShifts: 6, shiftsNeedingDocuments: 3, shiftsNeedingServiceApproval: 4, shiftsOutsideApprovedHours: 1, standingAssignmentsNeedingDocuments: 2, standingAssignmentsNeedingServiceApproval: 3 },
  affectedShiftsCount: 3,
});

export const okChecks = () => [
  { check: "caregiver", status: "ok", code: null, message: null, enforced: true, blocking: false },
  { check: "service", status: "ok", code: null, message: null, enforced: true, blocking: false },
  { check: "cpr", status: "ok", code: null, message: null, enforced: true, blocking: false },
  { check: "tb", status: "ok", code: null, message: null, enforced: true, blocking: false },
  { check: "availability", status: "ok", code: null, message: null, enforced: true, blocking: false },
  { check: "conflict", status: "ok", code: null, message: null, enforced: true, blocking: false },
];

export function fakeApi(opts: FakeOptions) {
  const calls: Call[] = [];
  const state = {
    createdTypes: [] as Array<{ documentTypeId: string; name: string; requiresExpiry: boolean; isActive: boolean }>,
    availability: { ...baseAvailability(), ...(opts.availability ?? {}) } as Record<string, any>,
    readiness: { ...baseReadiness(), ...(opts.readiness ?? {}) } as Record<string, any>,
    evaluation: { startsAt: "2026-10-14T16:00:00+00:00", endsAt: "2026-10-14T18:00:00+00:00", ready: true, wouldBlockAfterActivation: false, outcome: "allowed", summary: "Allowed", checks: okChecks(), ...(opts.evaluation ?? {}) } as Record<string, any>,
    failNext: opts.failNextRequestWith ?? null,
    shiftOverride: opts.shiftOverride === true,
    compliance: { ...baseCompliance(), ...(opts.compliance ?? {}) } as Record<string, any>,
    holds: (opts.holds ?? { holds: [], totals: { holds: 0, affectedShifts: 0, affectedAssignments: 0, inProgressVisits: 0 } }) as Record<string, any>,
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = new Headers(init?.headers).get("idempotency-key");
    calls.push({ method, path: url.pathname, body, key, query: Object.fromEntries(url.searchParams) });
    const route = `${method} ${url.pathname}`;
    const failing = opts.failFirst?.[route] ?? 0;
    if (failing > 0 && opts.failFirst) { opts.failFirst[route] = failing - 1; return json(500, { error: { code: "internal", message: "Something went wrong." } }); }
    if (opts.hold?.[route]) await opts.hold[route];
    switch (route) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: opts.role, permissions: PERMISSIONS[opts.role] }], profile: null });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [
          { caregiverRecordId: CG, caregiverCode: "CG-0001", firstName: "Synthetic", lastName: "Alpha", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 1, openVisits: 0 },
          { caregiverRecordId: CG2, caregiverCode: "CG-0002", firstName: "Synthetic", lastName: "Beta", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 0, openVisits: 0 },
        ] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "C-104", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client", city: null }] });
      case "GET /v1/experience-tags":
        return json(200, { tags: [{ tagId: SVC, label: "ABA experience" }] });
      case "GET /v1/experience/me":
        return json(200, { experience: { reviewed: false, reviewedAt: null, tags: opts.myExperience ?? [] } });
      case "POST /v1/experience/me":
        return json(200, { saved: true });
      case `GET /v1/caregivers/${CG}/experience`:
        return json(200, { experience: { reviewed: false, reviewedAt: null, tags: [{ tagId: SVC, label: "ABA experience", status: "reported" }] } });
      case `POST /v1/caregivers/${CG}/experience/review`:
        return json(200, { reviewed: true });
      case `GET /v1/clients/${CLIENT}/experience-requirements`:
        return json(200, { requirements: [] });
      case `POST /v1/clients/${CLIENT}/experience-requirements`:
        return json(200, { saved: true });
      case `GET /v1/caregivers/${CG}/zip`:
      case `GET /v1/clients/${CLIENT}/zip`:
        return json(200, { location: { zip: "92592" } });
      case `POST /v1/caregivers/${CG}/zip`:
      case `POST /v1/clients/${CLIENT}/zip`:
        return json(200, { saved: true });
      case "GET /v1/location-data":
        if (url.searchParams.has("suggestZip")) return json(200, { city: url.searchParams.get("suggestZip") === "92595" ? "Wildomar" : null });
        return json(200, { status: { distanceDataLoaded: false } });
      case "POST /v1/experience-tags":
        return json(201, { tagId: SVC });
      case "GET /v1/assignments":
        return json(200, { assignments: [] });
      case "GET /v1/availability":
        return json(200, { availability: state.availability });
      case "GET /v1/availability/requests":
        return json(200, { requests: (state.availability.pending as any[]).map((p) => ({ ...p, caregiverRecordId: CG, caregiverCode: "CG-0001", caregiverName: "Synthetic Alpha" })) });
      case `GET /v1/availability/requests/${"r1"}`:
        return json(200, { preview: { requestId: "r1", kind: "weekly", status: "pending", current: state.availability.weekly, proposed: [{ weekday: 1, start_local: "10:00", end_local: "12:00" }],
          affectedShifts: [{ shiftId: SHIFT, startsAt: "2026-10-19T17:00:00Z", endsAt: "2026-10-19T19:00:00Z" }], note: "Approving availability does not assign work or change booked shifts." } });
      case "POST /v1/availability/requests":
        if (state.failNext) { const f = state.failNext; state.failNext = null; return json(f.status, { error: { code: f.code, message: f.message } }); }
        return json(201, { requestId: "r-new" });
      case "POST /v1/availability/requests/r1/review":
        return json(200, { result: { status: body.decision === "approve" ? "approved" : "declined", approvedVersion: 3, affectedShifts: [] } });
      case "POST /v1/availability/requests/r1/withdraw":
        return json(200, { withdrawn: true });
      case `POST /v1/caregivers/${CG}/availability`:
        return json(200, { result: { status: "approved", approvedVersion: 3, affectedShifts: [{ shiftId: SHIFT }] } });
      case "GET /v1/care-opportunities":
        return json(200, { opportunities: [] });
      case "GET /v1/caregiver-services":
        return json(200, { approvals: opts.approvals ?? [] });
      case "POST /v1/caregiver-services":
        return json(201, { approvalId: "ap-new" });
      case "GET /v1/caregiver-services/review":
        return json(200, { pairs: opts.reviewPairs ?? [] });
      case "POST /v1/caregiver-services/bulk-approve":
        return json(200, { result: { batchId: "b1", approved: body.pairs.length, alreadyApproved: 0 } });
      case "GET /v1/document-readiness":
        return json(200, { readiness: { caregiverRecordId: CG, requirements: opts.documents ?? [{ requirement: "cpr", status: "ok", validUntil: "2027-03-01" }, { requirement: "tb", status: "awaiting_review", validUntil: null }] } });
      case "GET /v1/readiness":
        return json(200, { readiness: state.readiness });
      case "POST /v1/readiness/activate":
        state.readiness = { ...state.readiness, enforcementActive: true };
        return json(200, { readiness: state.readiness });
      case "POST /v1/readiness/service-checks":
        state.readiness = { ...state.readiness, serviceChecks: { ...(state.readiness.serviceChecks as object), state: body.enabled ? "On" : "Off", enabled: body.enabled, offHeadline: body.enabled ? null : "Service checks: Off", offMessage: body.enabled ? null : "Caregivers can be assigned without service approval." } };
        return json(200, { readiness: state.readiness });
      case "GET /v1/document-requirements":
        return json(200, { setup: { incomplete: true, requirements: [
          { requirement: "cpr", documentTypeId: null, documentTypeName: null, validityBasis: null, validityDays: null, complete: false, gap: "type_not_set" },
          { requirement: "tb", documentTypeId: null, documentTypeName: null, validityBasis: null, validityDays: null, complete: false, gap: "type_not_set" }] } });
      case "GET /v1/document-types":
        return json(200, { types: [{ documentTypeId: "dt1", name: "CPR card", requiresExpiry: true, isActive: true }, { documentTypeId: "dt2", name: "TB result", requiresExpiry: false, isActive: true }, ...state.createdTypes] });
      case "POST /v1/document-types": {
        const id = `dt-${String(body.name).toLowerCase()}`;
        state.createdTypes.push({ documentTypeId: id, name: String(body.name), requiresExpiry: !!body.requiresExpiry, isActive: true });
        return json(201, { documentTypeId: id });
      }
      case "POST /v1/document-requirements/type":
      case "POST /v1/document-requirements/policy":
        return json(200, { saved: true });
      case "POST /v1/readiness/evaluate":
        return json(200, { evaluation: state.evaluation });
      case "POST /v1/availability/overrides":
        state.evaluation = { ...state.evaluation, ready: true, outcome: "allowed", summary: "Allowed", checks: (state.evaluation.checks as any[]).map((c) => (c.check === "availability" ? { ...c, status: "overridden", blocking: false, code: "availability_override", message: "Availability overridden by an administrator." } : c)) };
        return json(201, { overrideId: "ov1" });
      case "GET /v1/shifts":
        return json(200, { shifts: [{ shiftId: SHIFT, startsAt: "2026-10-14T16:00:00Z", endsAt: "2026-10-14T18:00:00Z", localDate: "2026-10-14", coverageState: "needs_coverage", clientId: CLIENT, clientCode: "C-104", clientName: "Synthetic Client", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care", caregiverRecordId: null, caregiverCode: null, caregiverName: null, hasSignIn: false, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null, seriesId: null, availabilityOverride: state.shiftOverride === true, availabilityOverrideReason: state.shiftOverride === true ? "Caregiver agreed by phone" : null }] });
      case "GET /v1/care-requests":
        return json(200, { requests: [{ requestId: REQ, clientCode: "C-104", serviceCode: "PCS", serviceName: "Personal care", startsAt: "2026-10-14T16:00:00Z", endsAt: "2026-10-14T20:00:00Z", requestedMinutes: 240, status: "requested", shortNotice: false, assignedCaregiverName: null, responseCount: 0 }] });
      case `GET /v1/care-requests/${REQ}/matches`:
        return json(200, { matches: opts.matches ?? defaultMatches() });
      case `GET /v1/care-requests/${REQ}/offers`:
        return json(200, { offers: [] });
      case `POST /v1/care-requests/${REQ}/offers`:
        return json(201, { offer: { offerId: "o1", token: "t".repeat(64) } });
      case "GET /v1/care-notifications":
        return json(200, { notifications: [] });
      case "GET /v1/care-portals/clients":
        return json(200, { clients: [] });
      case "GET /v1/care-alert-staff":
        return json(200, { staff: [] });
      case `GET /v1/caregivers/${CG}/compliance`:
        return json(200, { compliance: state.compliance });
      case `POST /v1/caregivers/${CG}/hire-date`:
        state.compliance = { ...state.compliance, hireDate: body.hireDate };
        return json(200, { compliance: state.compliance });
      case `POST /v1/caregivers/${CG}/background-check/status`:
        state.compliance = { ...state.compliance, background: { ...state.compliance.background, status: body.status, qualifies: false, result: null, verifiedAt: null } };
        return json(200, { compliance: state.compliance });
      case `POST /v1/caregivers/${CG}/background-check/verify`:
        state.compliance = { ...state.compliance, background: { ...state.compliance.background, status: "completed", result: body.result, qualifies: body.result === "approved", state: body.result === "approved" ? "approved" : "not_approved", verifiedAt: "2026-10-17T18:00:00Z", verifiedByName: "Synthetic Owner", evidenceNote: body.evidenceNote } };
        return json(200, { compliance: state.compliance });
      case "GET /v1/compliance/holds":
        return json(200, state.holds);
      case "POST /v1/compliance/sweep":
        return json(200, { result: { evaluated: 4, holdsOpened: 1, holdsReleased: 0 } });
      default:
        return json(404, { error: { code: "not_found", message: `No such endpoint: ${route}` } });
    }
  });
  return { calls, fetchImpl, state };
}

export function defaultMatches() {
  const component = (name: string, weight: number, points: number | null, status: string, reason: string) => ({ name, weight, points, status, reason });
  return {
    ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional", rankedByScore: false, note: "Score incomplete for at least one eligible caregiver, so the list is not ordered by score.",
    candidates: [
      { caregiverRecordId: CG, caregiverCode: "CG-0001", name: "Synthetic Alpha", eligibility: "eligible", coverage: { covered: 1, total: 1, uncoveredDates: [] }, blockedChecks: [], warnings: [{ check: "cpr", message: "CPR missing." }],
        assignedToClient: true, scheduledMinutesThatWeek: 0,
        score: { ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional", complete: false, label: "Score incomplete", total: null, components: [
          component("availability", 50, 50, "scored", "1 of 1 time range covered"), component("location", 25, null, "missing", "Distance data is not loaded."), component("experience", 25, null, "not_applicable", "The client has no experience wishes recorded.")] } },
      { caregiverRecordId: CG2, caregiverCode: "CG-0002", name: "Synthetic Beta", eligibility: "not_eligible", coverage: { covered: 0, total: 1, uncoveredDates: ["2026-10-14"] },
        blockedChecks: [{ check: "availability", status: "blocked", code: "availability_not_provided", message: "Availability not provided.", occurrences: 1 }], warnings: [], assignedToClient: false, scheduledMinutesThatWeek: 0,
        score: { ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional", complete: false, label: "Score incomplete", total: null, components: [] } },
    ],
  };
}
