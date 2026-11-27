// Home labels, visit exceptions and the verification reports (0124, behind the homeLabels release switch). Where the switch is off the routes do not exist and the browser sees a
// failed request, so `available` is true only when the settings request actually succeeded. Every control stays out of sight unless it did.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";

export interface ServiceLocation {
  locationId: string; kind: "home" | "community"; name: string; street: string | null; city: string; state: string; zip: string; geoStatus: string; needsAttention: boolean; radiusM: number;
  labelId: string | null; labelCode: string | null; labelInstalledAt: string | null;
}
export interface LabelRow {
  labelId: string; labelCode: string; status: "unassigned" | "active" | "disabled" | "replaced"; clientCode: string | null; locationName: string | null; locationCity: string | null;
  installedAt: string | null; endedAt: string | null; replacedByCode: string | null; lastUsedAt: string | null; createdAt: string; locationNeedsAttention: boolean | null;
}

export function useHomeLabelsAvailable(enabled = true) {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["home-labels-available", activeOrganizationId],
    queryFn: async () => { await api!.get("/v1/verification-settings", { organizationId: activeOrganizationId }); return true; },
    enabled: enabled && !!api && !!activeOrganizationId,
    retry: false, staleTime: 5 * 60_000,
  });
  return { available: q.isSuccess && q.data === true };
}

/** The link a sticker opens. Built in the browser from the token; the token never reaches a URL path or a query string. */
export const labelUrl = (token: string) => `${window.location.origin}/l#${token}`;

/** Sticker capture by tap (NFC) or scan (QR), where the phone's browser supports it. Both resolve to the sticker's link; typing the sticker ID always works. */
export const nfcSupported = () => typeof window !== "undefined" && "NDEFReader" in window;
export const qrScanSupported = () => typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
export async function readNfcLink(signal: AbortSignal): Promise<string | null> {
  const Reader = (window as unknown as { NDEFReader: new () => { scan(o: { signal: AbortSignal }): Promise<void>; onreading: ((e: { message: { records: Array<{ recordType: string; data: DataView }> } }) => void) | null } }).NDEFReader;
  const reader = new Reader();
  await reader.scan({ signal });
  return new Promise((resolve) => {
    reader.onreading = (event) => {
      for (const record of event.message.records) if (record.recordType === "url" || record.recordType === "text") { resolve(new TextDecoder().decode(record.data)); return; }
      resolve(null);
    };
    signal.addEventListener("abort", () => resolve(null));
  });
}
export async function scanQrLink(signal: AbortSignal): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
  const detector = new Detector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const video = document.createElement("video");
  video.srcObject = stream; video.muted = true; await video.play();
  try {
    while (!signal.aborted) {
      const found = await detector.detect(video).catch(() => []);
      if (found[0]) return found[0].rawValue;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  } finally { stream.getTracks().forEach((t) => t.stop()); }
}
