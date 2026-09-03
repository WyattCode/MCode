import { PROVIDER_MARKS, type MarkPath } from "./provider-marks"

/**
 * How a provider is drawn wherever one is listed.
 *
 * The marks themselves are generated - see scripts/gen-provider-icons.ts. This
 * is the part that decides how to show them. Every built-in vendor has a mark;
 * the monogram is what a custom provider gets, since there is no logo to look
 * up for a base URL someone typed in.
 */

const NEUTRAL = "#8f98a6"

/** Perceived brightness of a #rrggbb colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const value = hex.replace("#", "")
  if (value.length !== 6) return 1
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The colour to actually paint with.
 *
 * Several vendors' official colour is black - a mark meant for white paper.
 * Painting that on this app's near-black surfaces would hide it, so anything
 * that dark is swapped for a light neutral, which is what a black-on-white mark
 * becomes when it is inverted anyway.
 */
export function providerColor(id: string): string {
  const color = PROVIDER_MARKS[id]?.color ?? NEUTRAL
  return luminance(color) < 0.22 ? "var(--text-base)" : color
}

/** The drawn mark, or nothing for a provider with no logo of its own. */
export function providerPaths(id: string): MarkPath[] | undefined {
  return PROVIDER_MARKS[id]?.paths
}

/** The stand-in for a custom provider, which has no logo to look up. */
export function providerMonogram(name: string): string {
  return name.slice(0, 1).toUpperCase()
}
