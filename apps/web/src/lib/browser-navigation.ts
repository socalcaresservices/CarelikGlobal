/**
 * Small boundary around full-page navigation. Keeping this separate from
 * React Router makes cross-host redirects explicit and independently
 * replaceable in tests.
 */
export function replaceBrowserLocation(url: string) {
  window.location.replace(url);
}
