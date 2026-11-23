import { vi } from "vitest";

/** Captures the file a page hands to the browser (Blob + anchor click) so a test can read the CSV it would download. */
export function captureCsvDownload() {
  const blobs: Blob[] = [];
  const create = vi.spyOn(URL, "createObjectURL" as never).mockImplementation(((blob: Blob) => { blobs.push(blob); return "blob:test"; }) as never);
  const revoke = vi.spyOn(URL, "revokeObjectURL" as never).mockImplementation((() => {}) as never);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return {
    async rows(): Promise<string[][]> {
      const blob = blobs[blobs.length - 1];
      if (!blob) throw new Error("No file was downloaded");
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
      return parseCsv(text);
    },
    restore() { create.mockRestore(); revoke.mockRestore(); click.mockRestore(); },
  };
}

/** Minimal quoted-CSV reader for the files our pages build (quotes doubled, CRLF or LF rows). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}
