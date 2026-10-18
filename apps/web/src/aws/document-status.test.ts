import { describe, expect, it } from "vitest";
import { documentDateLine, parseReminderDays, uploadFailureMessage, type StaffDocument } from "./document-status";

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

describe("reminder days (0033)", () => {
  it("parses 1–8 different whole days from 1 to 365, largest first; refuses anything else", () => {
    expect(parseReminderDays("90, 60, 30, 14, 7")).toEqual([90, 60, 30, 14, 7]);
    expect(parseReminderDays("7 30 14")).toEqual([30, 14, 7]);
    for (const bad of ["", "0", "400", "30, 30", "1,2,3,4,5,6,7,8,9", "thirty", "1.5"]) expect(parseReminderDays(bad)).toBeNull();
  });
});

describe("uploadFailureMessage: what failed, how to fix it, and that nothing was saved", () => {
  it("keeps a specific reason and adds that nothing was saved", () => {
    expect(uploadFailureMessage(new Error("This PDF is larger than 4 MB. Scan it at a lower resolution or upload a photo."))).toBe("This PDF is larger than 4 MB. Scan it at a lower resolution or upload a photo. Nothing was saved.");
    expect(uploadFailureMessage(new Error("The server refused it"))).toBe("The server refused it. Nothing was saved.");
  });
  it("turns a network failure into a plain sentence and never shows an empty message", () => {
    expect(uploadFailureMessage(new TypeError("Failed to fetch"))).toBe("Upload failed: no connection. Nothing was saved; try again.");
    expect(uploadFailureMessage(undefined)).toBe("Upload failed: no connection. Nothing was saved; try again.");
  });
});
