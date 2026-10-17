/** Deterministic color helpers for derived tones (shimmer particles). */

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Linear mix in sRGB: `amount` 0 → `a`, 1 → `b`. */
export function mix(a: string, b: string, amount: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return toHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * amount) as [number, number, number]);
}

export const normalizeHex = (hex: string): string => toHex(channels(hex));

/** Light, warm-neutral tint for shimmer particles. */
export const shimmerTint = (hex: string): string => mix(hex, '#FFF4E6', 0.6);
