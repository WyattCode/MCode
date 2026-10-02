/**
 * Installs the Android demo app for the device checks. The demo is signed
 * with a debug key kept in the temp folder; once that folder is cleaned a new
 * key is made, and Android refuses to update an app signed with the old one -
 * so a refused update uninstalls the old copy (only this demo) and installs.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { isTestDevice } from "./android-test-device"

export function installDemo(adb: string, serial: string, apk: string): void {
  // Nothing is installed on a phone, whatever chose it (android-test-device.ts).
  if (!isTestDevice(serial)) throw new Error(`${serial} is not an emulator; the demo app is only installed on one`)
  if (spawnSync(adb, ["-s", serial, "install", "-r", apk], { windowsHide: true, timeout: 120_000 }).status === 0) return
  spawnSync(adb, ["-s", serial, "uninstall", "dev.mcode.demo"], { windowsHide: true, timeout: 60_000 })
  execFileSync(adb, ["-s", serial, "install", apk], { stdio: "ignore", windowsHide: true, timeout: 120_000 })
}
