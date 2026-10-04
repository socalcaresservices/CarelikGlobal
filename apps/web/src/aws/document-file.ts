// Prepares a chosen file for upload: PDF/JPEG/PNG only, max 4 MB as stored
// (the server checks again by content). Large phone photos are scaled to at
// most 2000 px and re-encoded as JPEG so a normal camera photo fits.
export const MAX_DOCUMENT_BYTES = 4_000_000;
const MAX_IMAGE_EDGE = 2000;

export interface PreparedFile {
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  base64: string;
  byteSize: number;
}

/** Blob.arrayBuffer where available; FileReader for older phone browsers. */
function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("The file could not be read. Choose it again."));
    reader.readAsArrayBuffer(blob);
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function downscale(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This phone could not prepare the photo. Try a smaller photo or a PDF.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("This phone could not prepare the photo. Try a smaller photo or a PDF.");
  return blob;
}

export async function prepareDocumentFile(file: File): Promise<PreparedFile> {
  const type = file.type;
  if (type === "application/pdf") {
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error("This PDF is larger than 4 MB. Scan it at a lower resolution or upload a photo.");
    return { contentType: type, base64: toBase64(await readBytes(file)), byteSize: file.size };
  }
  if (type === "image/jpeg" || type === "image/png") {
    if (file.size <= MAX_DOCUMENT_BYTES) return { contentType: type, base64: toBase64(await readBytes(file)), byteSize: file.size };
    const smaller = await downscale(file);
    if (smaller.size > MAX_DOCUMENT_BYTES) throw new Error("This photo is still larger than 4 MB after resizing. Try again closer to the document.");
    return { contentType: "image/jpeg", base64: toBase64(await readBytes(smaller)), byteSize: smaller.size };
  }
  throw new Error("Upload a PDF, JPEG or PNG file.");
}
