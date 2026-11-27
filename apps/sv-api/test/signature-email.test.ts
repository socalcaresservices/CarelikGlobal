// The signing-link email text: one link, never the code, nothing about the visit. SYNTHETIC only.
import { describe, expect, it } from "vitest";
import { composeSignatureEmail } from "../src/signature-email";

const base = { agencyName: "Synthetic Care Co", url: `https://app.example.test/confirm-visit#${"ab".repeat(32)}`, expiresAt: new Date("2026-12-04T10:00:00Z") };
describe("signing-link email", () => {
  it("has a generic subject, the link, the expiry date and a sentence that the code comes by phone", () => {
    const m = composeSignatureEmail(base);
    expect(m.subject).toBe("Please confirm a care visit");
    for (const part of [m.text, m.html]) { expect(part).toContain(base.url); expect(part).toContain("December 4, 2026"); expect(part).toMatch(/6-digit code the agency gave you by phone/); }
    expect(m.text).toContain("Synthetic Care Co asks you to review and confirm a care visit.");
  });
  it("never contains a code, a name, a service or a time, and the subject carries no agency or visit detail", () => {
    const m = composeSignatureEmail(base);
    expect(m.subject).not.toMatch(/Synthetic|visit on|\d/);
    expect(m.text + m.html).not.toMatch(/\b\d{6}\b/);
    expect(m.text).toMatch(/does not include the code or any details of the visit/);
  });
  it("text keeps blank lines between paragraphs and the HTML uses real paragraphs and a list, so nothing collapses into one line", () => {
    const m = composeSignatureEmail(base);
    expect(m.text.split("\n\n").length).toBeGreaterThanOrEqual(5);
    expect((m.html.match(/<p/g) ?? []).length).toBeGreaterThanOrEqual(3); expect(m.html).toContain("<ol"); expect(m.html).toContain("<li");
  });
  it("escapes the agency name in HTML, strips line breaks from it, and escapes the link", () => {
    const m = composeSignatureEmail({ ...base, agencyName: 'A<script>"x"</script>\r\nB', url: 'https://app.example.test/x#a"b' });
    expect(m.html).not.toContain("<script>"); expect(m.html).toContain("A&lt;script&gt;&quot;x&quot;&lt;/script&gt; B"); expect(m.html).toContain("a&quot;b");
    expect(m.text).toContain('A<script>"x"</script> B asks you');
  });
});
