import { describe, expect, it } from "vitest";
import { documentDateLine, type StaffDocument } from "./document-status";

const base = { verifiedExpiresOn: null, dueOn: null, daysUntil: null } as unknown as StaffDocument;

describe("documentDateLine: exact date plus days, never colour alone", () => {
  it("expiry wording", () => {
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-14", daysUntil: 10 })).toBe("Expires Oct 14, 2026 (10 days left)");
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-04", daysUntil: 0 })).toBe("Expires today (Oct 4, 2026)");
    expect(documentDateLine({ ...base, verifiedExpiresOn: "2026-10-03", daysUntil: -1 })).toBe("Expired Oct 3, 2026 (1 day ago)");
  });
  it("due wording", () => {
    expect(documentDateLine({ ...base, dueOn: "2026-10-01", daysUntil: -3 })).toBe("Due Oct 1, 2026 (3 days overdue)");
    expect(documentDateLine({ ...base, dueOn: "2026-10-05", daysUntil: 1 })).toBe("Due Oct 5, 2026 (in 1 day)");
    expect(documentDateLine(base)).toBeNull();
  });
});
