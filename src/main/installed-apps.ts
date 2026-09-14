import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openApps } from "@shared/open-app"

/**
 * Which of this platform's open-with apps are really here, for MiMo's
 * 默认打开目标, which lists only the apps installed on the machine.
 *
 * On macOS an app is its bundle under /Applications (or ~/Applications), which
 * is what `open -a` finds. Elsewhere the app is started by name, so it counts as
 * present when that name resolves on PATH - an app that is installed but not
 * reachable that way could not be opened with anyway. Asked once per process.
 */
let asked: Promise<string[]> | undefined

export function installedOpenApps(platform: string = process.platform): Promise<string[]> {
  asked ??= Promise.all(
    openApps(platform).map(async (app) => ((await present(app.openWith, platform)) ? app.id : undefined)),
  ).then((ids) => ids.filter((id): id is string => Boolean(id)))
  return asked
}

function present(openWith: string, platform: string): Promise<boolean> {
  if (platform === "darwin") {
    const roots = ["/Applications", path.join(os.homedir(), "Applications")]
    return Promise.resolve(roots.some((root) => fs.existsSync(path.join(root, `${openWith}.app`))))
  }
  return new Promise((resolve) => {
    execFile(platform === "win32" ? "where.exe" : "which", [openWith], { windowsHide: true, timeout: 4000 }, (error) =>
      resolve(!error),
    )
  })
}
