/**
 * The browser the app tool opens web pages in: the machine's own Edge or
 * Chrome, started with a DevTools port and a profile of its own, so it never
 * touches the user's browsing profile, logins or extensions. The window is
 * shown - the user watches their app being driven, and can take it over.
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

/** Where Chromium browsers install, the one to prefer first. Edge ships with every Windows 10 and 11. */
function candidates(): string[] {
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    // Chrome before Edge: Edge signs a fresh profile into the Windows account on its own (see launchBrowser).
    return [
      ...roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    ]
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"]
}

/** The first Chromium browser installed here; MCODE_APP_BROWSER names another. */
export function findBrowser(): string | undefined {
  const named = process.env.MCODE_APP_BROWSER
  if (named) return fs.existsSync(named) ? named : undefined
  return candidates().find((file) => fs.existsSync(file))
}

export interface LaunchedBrowser {
  child: ChildProcess
  port: number
  profile: string
}

/**
 * Starts the browser on a port of its choosing. Chromium writes the port it
 * took into DevToolsActivePort in the profile folder; that is read rather than
 * a port picked here, which could be taken by the time the browser binds it.
 */
export async function launchBrowser(executable: string, timeoutMs = 15_000): Promise<LaunchedBrowser> {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "mcode-app-browser-"))
  /*
   * Edge signs even a brand-new profile into the Windows account by itself and
   * starts syncing it (measured 2026-09-28: a sync confirmation page, and an
   * account in Preferences, whatever flags were given). So nothing is synced,
   * and the page runs in a guest window, which holds no account at all.
   */
  const edge = /msedge/i.test(path.basename(executable))
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      "--disable-sync",
      ...(edge ? ["--guest"] : []),
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The app under test keeps its own timers and animations at full speed while its window is behind another.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=Translate,msEdgeSidebarV2,msUndersideButton",
      "--new-window",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: false },
  )
  /*
   * The launcher is not always the browser: Edge's hands its window to another
   * process and exits at once, so its exit proves nothing. The port file is
   * the only sign that counts, and closing goes through the DevTools
   * connection (Browser.close) rather than this process handle.
   */
  let failed: Error | undefined
  child.once("error", (error) => (failed = error))
  const marker = path.join(profile, "DevToolsActivePort")
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (failed) throw new Error(`${path.basename(executable)} could not be started: ${failed.message}`)
    const text = await fsp.readFile(marker, "utf8").catch(() => "")
    const port = Number(text.split(/\r?\n/)[0])
    if (port > 0) return { child, port, profile }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error(`${path.basename(executable)} did not open a DevTools port within ${timeoutMs / 1000}s`)
}

/** Ends a browser this tool started, and removes its throwaway profile. */
export async function closeBrowser(browser: LaunchedBrowser): Promise<void> {
  if (browser.child.exitCode === null) {
    const gone = new Promise((resolve) => browser.child.once("exit", resolve))
    browser.child.kill()
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3_000))])
  }
  // The profile can stay locked for a moment after the process ends; a leftover temp folder is harmless.
  await fsp.rm(browser.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
}
