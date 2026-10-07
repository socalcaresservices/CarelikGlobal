function hexToLuminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
/** Contrast of white text on this colour (the server enforces the same 4.5:1 rule). */
export function contrastWithWhite(hex: string): number {
  return Math.round((1.05 / (hexToLuminance(hex) + 0.05)) * 100) / 100;
}
