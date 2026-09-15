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
let asked: Promise<{ id: string; file: string }[]> | undefined

function located(platform: string): Promise<{ id: string; file: string }[]> {
  asked ??= Promise.all(
    openApps(platform).map(async (app) => {
      const file = await locate(app.openWith, platform)
      return file ? { id: app.id, file } : undefined
    }),
  ).then((rows) => rows.filter((row): row is { id: string; file: string } => Boolean(row)))
  return asked
}

export async function installedOpenApps(platform: string = process.platform): Promise<string[]> {
  return (await located(platform)).map((row) => row.id)
}

/*
 * MiMo draws each app's own icon beside its name in the picker. The icons come
 * from the files the apps were found at; one that cannot be read is left out and
 * the picker draws the name's first letter instead.
 */
export async function installedOpenAppIcons(
  getIcon: (file: string) => Promise<string>,
  platform: string = process.platform,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const row of await located(platform)) {
    const icon = await getIcon(row.file).catch(() => "")
    if (icon) out[row.id] = icon
  }
  return out
}

/** Where an app lives, or nothing when it is not installed. */
function locate(openWith: string, platform: string): Promise<string | undefined> {
  if (platform === "darwin") {
    const roots = ["/Applications", path.join(os.homedir(), "Applications")]
    return Promise.resolve(
      roots.map((root) => path.join(root, `${openWith}.app`)).find((bundle) => fs.existsSync(bundle)),
    )
  }
  return new Promise((resolve) => {
    execFile(
      platform === "win32" ? "where.exe" : "which",
      [openWith],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => resolve(error ? undefined : String(stdout).split(/\r?\n/)[0]?.trim() || undefined),
    )
  })
}
