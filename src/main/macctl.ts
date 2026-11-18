import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { app, desktopCapturer, ipcMain, screen, shell, systemPreferences } from "electron"
import { INPUT_SETTINGS, SCREEN_SETTINGS, installMacOSHost, type MacWindow } from "../server/appdrive/macos"
import { splitCombo, StepError } from "../server/appdrive/stepping"
import { writeAtomicSync } from "./atomic-write"

const run = promisify(execFile)

const KEYS: Record<string, number> = {
  enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 117,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126, home: 115, end: 119,
  pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
}
const MODIFIERS: Record<string, string> = {
  cmd: "command down", command: "command down", meta: "command down",
  control: "control down", ctrl: "control down", option: "option down", alt: "option down", shift: "shift down",
}

function pressArgs(key: string): string[] {
  const { name, modifiers } = splitCombo(key)
  const using = modifiers.map((modifier) => {
    const mapped = Object.hasOwn(MODIFIERS, modifier.toLowerCase()) && MODIFIERS[modifier.toLowerCase()]
    if (!mapped) throw new StepError(`Unknown modifier "${modifier}". Use Command, Control, Option or Shift.`)
    return mapped
  })
  const code = Object.hasOwn(KEYS, name.toLowerCase()) ? KEYS[name.toLowerCase()] : undefined
  if (code !== undefined) return ["code", String(code), ...using]
  if (/^[ -~]$/.test(name)) return ["text", name, ...using]
  throw new StepError(`Unknown key "${name}".`)
}

export function registerMacOSControl(): void {
  if (process.platform !== "darwin") return
  const prefs = path.join(app.getPath("userData"), "macctl-enabled")
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources")
  const script = path.join(resources, "macctl", "system-events.js")
  const shim = path.join(resources, "macctl", "mcode-cgevent")
  let enabled = false
  try {
    enabled = readFileSync(prefs, "utf8") === "true"
  } catch {
    // Default to off on first launch or when preferences are unreadable.
  }
  const status = () => ({
    enabled,
    capture: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  })
  const assertEnabled = () => {
    if (!enabled) throw new StepError("Computer Control is off.")
  }
  const systemEvents = (action: string, target: string, args: string[] = []) =>
    run("/usr/bin/osascript", ["-l", "JavaScript", script, action, target, ...args], { timeout: 2_000, maxBuffer: 256_000 })
  const inputError = (error: unknown): StepError => {
    const details = (error as { stderr?: string }).stderr ?? ""
    if (/not in front|no longer in front/i.test(details)) return new StepError("Bring the requested application to the front and try again.")
    if (/outside the primary display/i.test(details)) return new StepError("Coordinates must be within the primary display.")
    if (/do not hit a window/i.test(details)) return new StepError("The point is outside the requested app’s visible windows. Take a new snapshot.")
    return new StepError(`Desktop input was unavailable. Check ${INPUT_SETTINGS} and allow MCode to control System Events. The requested app must be in front.`)
  }

  ipcMain.handle("mcode:macctl-status", status)
  ipcMain.handle("mcode:macctl-toggle", (_event, wanted: unknown) => {
    if (typeof wanted === "boolean") {
      writeAtomicSync(prefs, String(wanted), 0o600)
      enabled = wanted
    }
    return status()
  })
  ipcMain.handle("mcode:macctl-settings", (_event, pane: unknown) =>
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${
      pane === "automation" ? "Privacy_Automation" : pane === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
    }`),
  )

  installMacOSHost({
    enabled: () => enabled,
    async launch(target) {
      assertEnabled()
      const byBundleID = /^[\w-]+(?:\.[\w-]+){2,}$/.test(target) && !target.endsWith(".app")
      await run("/usr/bin/open", [byBundleID ? "-b" : "-a", target], { timeout: 5_000 }).catch(() => {
        throw new StepError(`Could not open "${target}". Check the installed app name or bundle ID.`)
      })
    },
    async activate(target) {
      assertEnabled()
      try {
        await systemEvents("activate", target)
      } catch (error) {
        throw inputError(error)
      }
    },
    async inspect(target) {
      assertEnabled()
      if (!systemPreferences.isTrustedAccessibilityClient(false)) throw new StepError(INPUT_SETTINGS)
      const { stdout } = await systemEvents("inspect", target)
      return JSON.parse(stdout) as MacWindow
    },
    async capture(target) {
      assertEnabled()
      if (systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new StepError(`Allow MCode in ${SCREEN_SETTINGS}.`)
      const { stdout: before } = await systemEvents("front", target).catch(() => {
        throw new StepError("Bring the requested application to the front to capture it.")
      })
      assertEnabled()
      const display = screen.getPrimaryDisplay()
      const { width, height } = display.size
      let deadline: ReturnType<typeof setTimeout> | undefined
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new StepError("The desktop capture timed out.")), 5_000)
        }),
      ]).finally(() => clearTimeout(deadline))
      const { stdout: after } = await systemEvents("front", target).catch(() => {
        throw new StepError("The requested application left the foreground during capture.")
      })
      assertEnabled()
      if (before !== after) throw new StepError("The requested application changed during capture.")
      const source = sources.find((entry) => entry.display_id === String(display.id))
      if (!source || source.thumbnail.isEmpty()) throw new StepError(`The primary display could not be captured. Check ${SCREEN_SETTINGS}.`)
      return { png: source.thumbnail.toPNG(), width, height }
    },
    async input(target, input) {
      assertEnabled()
      if (input.action === "click" && !existsSync(shim)) throw new StepError("Coordinate clicks require the build-time CGEvent shim. This build supports keyboard input through System Events.")
      if (!systemPreferences.isTrustedAccessibilityClient(false)) throw new StepError(`Allow MCode in ${INPUT_SETTINGS}.`)
      const key = input.action === "press" ? pressArgs(input.key) : undefined
      try {
        if (input.action === "click") {
          const { stdout } = await systemEvents("front", target)
          const { pid } = JSON.parse(stdout) as { pid: number }
          assertEnabled()
          await run(shim, [String(pid), String(input.point.x), String(input.point.y), String(input.count)], { timeout: 2_000 })
        } else if (input.action === "type") {
          await systemEvents("type", target, [input.text, String(input.clear), String(input.submit)])
        } else {
          await systemEvents("press", target, key)
        }
      } catch (error) {
        throw inputError(error)
      }
    },
  })
}
