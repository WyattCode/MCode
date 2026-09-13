import type { AppConfig } from "./protocol"

/**
 * The sound a long task makes when it ends.
 *
 * Only a task that ran for more than a minute earns one: a quick answer is
 * still on screen when it lands, and a tone after every reply would soon be
 * switched off. The choice is one of five short figures, or none.
 */
export type Chime = AppConfig["taskDoneSound"]
export type ChimeName = Exclude<Chime, "off">

export const CHIMES: readonly ChimeName[] = ["settle", "triple", "sweep", "duet", "zen"]
export const DEFAULT_CHIME: ChimeName = "settle"
export const LONG_TASK_MS = 60_000

/** Anything unrecognised - an older config, a hand edit - plays the default. */
export function chimeOf(value: unknown): Chime {
  if (value === "off") return "off"
  return CHIMES.includes(value as ChimeName) ? (value as ChimeName) : DEFAULT_CHIME
}

/** A minute exactly is still quick; the chime is for what ran past it. */
export function longTask(elapsed: number): boolean {
  return Number.isFinite(elapsed) && elapsed > LONG_TASK_MS
}
