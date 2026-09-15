import type { AppConfig } from "./protocol"

/**
 * The sound a long task makes when it ends.
 *
 * Only a task that ran for more than a minute earns one: a quick answer is
 * still on screen when it lands, and a tone after every reply would soon be
 * switched off. The choice is one of MiMo's eight, drawn with MCode's own
 * voices, or none; 晨曦 (bloom) is where it starts.
 */
export type Chime = AppConfig["taskDoneSound"]
export type ChimeName = Exclude<Chime, "off">

export const CHIMES: readonly ChimeName[] = ["rhodes", "handpan", "vibes", "bloom", "harp", "kalimba", "bowl", "koto"]
export const DEFAULT_CHIME: ChimeName = "bloom"
export const LONG_TASK_MS = 60_000

/** Anything unrecognised - an older config, a hand edit - plays the default. */
export function chimeOf(value: unknown): Chime {
  if (value === "off") return "off"
  return CHIMES.includes(value as ChimeName) ? (value as ChimeName) : DEFAULT_CHIME
}

/*
 * Earlier builds offered five figures of their own. A stored one moves to the
 * nearest of the eight in character, so a choice made on purpose stays a
 * choice rather than falling back to the default.
 */
const RETIRED: Record<string, ChimeName> = {
  settle: "bloom",
  triple: "vibes",
  sweep: "harp",
  duet: "kalimba",
  zen: "bowl",
}

export function migrateChime(value: unknown): Chime {
  return typeof value === "string" && value in RETIRED ? RETIRED[value] : chimeOf(value)
}

/** A minute exactly is still quick; the chime is for what ran past it. */
export function longTask(elapsed: number): boolean {
  return Number.isFinite(elapsed) && elapsed > LONG_TASK_MS
}
