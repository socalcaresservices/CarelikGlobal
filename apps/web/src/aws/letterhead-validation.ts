export const LETTERHEAD_FIELDS = [
  { id: "legalName", label: "Legal name (as printed)", max: 120, autoComplete: "organization" },
  { id: "addressStreet", label: "Street address", max: 120, autoComplete: "street-address" },
  { id: "addressCity", label: "City", max: 80, autoComplete: "address-level2" },
  { id: "addressState", label: "State (2 letters)", max: 2, autoComplete: "address-level1" },
  { id: "addressZip", label: "ZIP code", max: 10, autoComplete: "postal-code" },
  { id: "contactPhone", label: "Phone", max: 25, autoComplete: "tel" },
  { id: "contactEmail", label: "Email", max: 254, autoComplete: "email" },
] as const;
export type LetterheadForm = Record<(typeof LETTERHEAD_FIELDS)[number]["id"], string>;
export const EMPTY_LETTERHEAD: LetterheadForm = { legalName: "", addressStreet: "", addressCity: "", addressState: "", addressZip: "", contactPhone: "", contactEmail: "" };

/** The same rules the database enforces, so a mistake is caught before saving. A blank field is allowed and prints nothing. */
export function letterheadProblem(f: LetterheadForm): string | null {
  const v = (x: string) => x.trim();
  if (v(f.legalName) && (v(f.legalName).length < 2 || v(f.legalName).length > 120)) return "Legal name must be between 2 and 120 characters.";
  if (v(f.addressStreet) && (v(f.addressStreet).length < 2 || v(f.addressStreet).length > 120)) return "Street address must be between 2 and 120 characters.";
  if (v(f.addressCity) && (v(f.addressCity).length < 2 || v(f.addressCity).length > 80)) return "City must be between 2 and 80 characters.";
  if (v(f.addressState) && !/^[A-Za-z]{2}$/.test(v(f.addressState))) return "State must be two letters, for example CA.";
  if (v(f.addressZip) && !/^[0-9]{5}(-[0-9]{4})?$/.test(v(f.addressZip))) return "ZIP code must be 5 digits, or 5 digits, a dash and 4 digits.";
  if (v(f.contactPhone) && (v(f.contactPhone).length < 7 || v(f.contactPhone).length > 25 || !/^[0-9+(). -]+$/.test(v(f.contactPhone)))) return "Phone may contain digits, spaces and + ( ) . - only (7 to 25 characters).";
  if (v(f.contactEmail) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v(f.contactEmail))) return "Enter a valid email address.";
  return null;
}

