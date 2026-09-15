/*
 * Measurements for MiMo's inline media cards in a reply, kept apart from the
 * components so the checks can run them without a window.
 */

/** MiMo's voice bubble: 198 wide while the length is unknown, else 178 + 3.2px a second, between 178 and 590. */
export function audioBubbleWidth(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 198
  return Math.round(Math.max(178, Math.min(590, 178 + 3.2 * seconds)))
}

/** A clip's length as m:ss, or h:mm:ss from an hour up. */
export function audioClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}
