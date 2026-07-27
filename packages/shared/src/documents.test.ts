import { describe, expect, it } from "vitest";
import {
  documentRequestBatchSchema,
  documentRequestSchema,
  documentRequestStatusSchema,
  documentRequestSubjectTypeSchema,
  documentTypeSchema
} from "./documents";

const validDocumentType = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: null,
  name: "CPR Certification",
  category: "certification",
  requiresExpiration: true,
  isActive: true
};

const validBatch = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  subjectType: "applicant" as const,
  subjectId: "33333333-3333-4333-8333-333333333333",
  subjectName: "Jordan Rivera",
  subjectEmail: "jordan@example.com",
  token: "a1b2c3d4e5f6",
  message: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  expiresAt: null
};

const validRequest = {
  id: "44444444-4444-4444-8444-444444444444",
  batchId: validBatch.id,
  documentTypeId: validDocumentType.id,
  documentTypeName: "CPR Certification",
  status: "requested" as const,
  uploadedAt: null,
  expiresAt: null,
  verifiedAt: null,
  rejectionReason: null,
  notes: null,
  batchToken: validBatch.token,
  batchCreatedAt: validBatch.createdAt
};

describe("documentRequestStatusSchema", () => {
  it("accepts every known status", () => {
    for (const value of documentRequestStatusSchema.options) {
      expect(documentRequestStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => documentRequestStatusSchema.parse("archived")).toThrow();
  });
});

describe("documentRequestSubjectTypeSchema", () => {
  it("accepts every known subject type", () => {
    for (const value of documentRequestSubjectTypeSchema.options) {
      expect(documentRequestSubjectTypeSchema.parse(value)).toBe(value);
    }
  });
});

describe("documentTypeSchema", () => {
  it("accepts a platform-default document type (organizationId null)", () => {
    expect(documentTypeSchema.parse(validDocumentType)).toEqual(validDocumentType);
  });

  it("accepts an organization's own custom document type", () => {
    const custom = { ...validDocumentType, organizationId: "11111111-1111-4111-8111-111111111111" };
    expect(documentTypeSchema.parse(custom)).toEqual(custom);
  });

  it("rejects an empty name", () => {
    expect(() => documentTypeSchema.parse({ ...validDocumentType, name: "" })).toThrow();
  });
});

describe("documentRequestBatchSchema", () => {
  it("accepts a well-formed batch", () => {
    expect(documentRequestBatchSchema.parse(validBatch)).toEqual(validBatch);
  });

  it("rejects an unknown subject type", () => {
    expect(() => documentRequestBatchSchema.parse({ ...validBatch, subjectType: "client" })).toThrow();
  });
});

describe("documentRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(documentRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it("accepts an uploaded/verified request with dates set", () => {
    const verified = {
      ...validRequest,
      status: "verified" as const,
      uploadedAt: "2026-07-28T01:00:00.000Z",
      verifiedAt: "2026-07-28T02:00:00.000Z",
      expiresAt: "2027-07-28"
    };
    expect(documentRequestSchema.parse(verified)).toEqual(verified);
  });
});
