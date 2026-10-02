/**
 * Which Android devices the checks may drive: an emulator, never a phone.
 *
 * The device checks used to run whenever exactly one device was connected.
 * On 2026-10-02 that one device was the user's own phone, plugged in for
 * something else: smoke opened its Settings, tapped through the WLAN page and
 * tried to install the demo app on it (the install was refused). A check has
 * no business on a device someone uses. An emulator is reached as
 * `emulator-NNNN` or on a local port (MuMu's 127.0.0.1:16384); anything else -
 * a USB serial, a phone over Wi-Fi debugging - is left alone unless named in
 * MCODE_ANDROID_DEVICE on purpose. scripts/bench/tasks/app-test-android/build.mjs
 * repeats the same test.
 */
export function isTestDevice(serial: string): boolean {
  const named = process.env.MCODE_ANDROID_DEVICE
  if (named) return serial === named
  return /^emulator-\d+$/.test(serial) || /^(?:127\.0\.0\.1|localhost):\d+$/.test(serial)
}

/** The skip line when no device may be driven. */
export function noTestDevice(connected: number): string {
  return connected ? "(skipped: only a phone is connected - the device checks run on an emulator, or on a device named in MCODE_ANDROID_DEVICE)" : "(skipped: no Android emulator connected)"
}
