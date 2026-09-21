/*
 * Why an update did not go in, as MiMo 26.920 tells it: one reason code per
 * way the install can fail, each with its own sentence, where 26.914 had three
 * generic lines around whatever error text came back.
 *
 * The main process answers an install request with one of these, the window's
 * start watchdog adds not-started, and a record left by an install that did not
 * finish is read back as one at the next launch. read-only-volume is macOS's
 * (an app started from its disk image); MCode builds for macOS have no
 * automatic updates, so there disabled answers first.
 */

export const UPDATE_REASONS = [
  "no-ready",
  "staging",
  "read-only-volume",
  "install-failed",
  "not-started",
  "version-mismatch",
  "stale",
  "disabled",
  "unknown",
] as const

export type UpdateReason = (typeof UPDATE_REASONS)[number]

/** What the main process says to a request to install: done, or the reason not, with any detail worth a second line. */
export type InstallAnswer = { ok: true } | { ok: false; reason: UpdateReason; hint?: string }

export function isUpdateReason(value: unknown): value is UpdateReason {
  return typeof value === "string" && (UPDATE_REASONS as readonly string[]).includes(value)
}

/**
 * The reason behind an install the last run did not finish. The record holds a
 * reason code where one applied (stale, version-mismatch, no-ready); anything
 * else it holds is the installer's own error, which is an install that failed
 * and keeps its words as the detail. A record that could not be read is unknown.
 */
export function interruptedReason(error: string): { reason: UpdateReason; hint: string } {
  if (isUpdateReason(error)) return { reason: error, hint: "" }
  if (!error.trim() || error === "invalid") return { reason: "unknown", hint: "" }
  return { reason: "install-failed", hint: error.trim() }
}

/** A running app on macOS that cannot replace itself: opened from its disk image, or moved nowhere and translocated. */
export function readOnlyInstall(execPath: string, platform: string): boolean {
  return platform === "darwin" && (/^\/Volumes\//.test(execPath) || execPath.includes("/AppTranslocation/"))
}
