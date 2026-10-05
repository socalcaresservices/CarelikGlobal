import { describe, expect, it } from "vitest";
import { documentDateLine, type StaffDocument } from "./document-status";

const base = { verifiedExpiresOn: null, dueOn: null, daysUntil: null } as unknown as StaffDocument;

describe("documentDateLine: exact date plus days, never colour alone", () => {
  it("expiry wording", () => {
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-14", daysUntil: 10 })).toBe("Expires 10/14/2026 (10 days left)");
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-04", daysUntil: 0 })).toBe("Expires today (10/04/2026)");
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-03", daysUntil: -1 })).toBe("Expired 10/03/2026 (1 day ago)");
  });
  it("due wording", () => {
    expect(documentDateLine({ ...base, dueOn: "2026-10-01", daysUntil: -3 })).toBe("Due 10/01/2026 (3 days overdue)");
    expect(documentDateLine({ ...base, dueOn: "2026-10-05", daysUntil: 1 })).toBe("Due 10/05/2026 (in 1 day)");
    expect(documentDateLine(base)).toBeNull();
  });
});
