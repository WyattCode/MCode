/**
 * A stored font size as the scale the interface is multiplied by, as MiMo
 * works it out: the size clamped to [min, max] over the base, and 1 for
 * anything that is not a positive number - so a hand-edited 100 cannot blow the
 * window up sevenfold, and "abc" cannot turn every size into NaN.
 */
export function fontScale(size: unknown, base: number, min: number, max: number): number {
  const value = typeof size === "number" ? size : Number.parseFloat(String(size))
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(max, Math.max(min, value)) / base
}
