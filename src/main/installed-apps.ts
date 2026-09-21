import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { docApps, launchableApps, openApps, type OpenApp } from "@shared/open-app"

/**
 * Which of this platform's open-with apps are really here, for MiMo's
 * 默认打开目标 and a delivered document's 打开方式, which list only the apps
 * installed on the machine.
 *
 * On macOS an app is a bundle in one of MiMo's five application folders -
 * Terminal lives in /System/Applications/Utilities, which /Applications alone
 * never found. Elsewhere the app is started by name, so it counts as present
 * when one of its names resolves on PATH - an app that is installed but not
 * reachable that way could not be opened with anyway. Asked once per process.
 */
export interface Found {
  id: string
  /** The bundle or the program found: what is opened with, and where the icon comes from. */
  file: string
}

/** MiMo's application folders, in its order. */
export function macApplicationFolders(home: string = os.homedir()): string[] {
  return [path.join(home, "Applications"), "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
}

/** The bundle names tried for an app on macOS. */
export function bundleNames(app: OpenApp): string[] {
  return app.find ?? [`${app.openWith}.app`]
}

/** The first bundle present, folder by folder, as MiMo searches. */
export function findBundle(app: OpenApp, exists: (file: string) => boolean = fs.existsSync, home?: string): string | undefined {
  for (const folder of macApplicationFolders(home)) {
    for (const name of bundleNames(app)) {
      const bundle = path.posix.join(folder.replace(/\\/g, "/"), name)
      if (exists(bundle)) return bundle
    }
  }
  return undefined
}

const found = new Map<string, Promise<string | undefined>>()

/** Where an app lives, or nothing when it is not installed; remembered per platform and app. */
function locate(app: OpenApp, platform: string): Promise<string | undefined> {
  const key = `${platform}\0${app.id}\0${app.openWith}`
  let answer = found.get(key)
  if (!answer) {
    answer = platform === "darwin" ? Promise.resolve(findBundle(app)) : onPath(app.find ?? [app.openWith], platform)
    found.set(key, answer)
  }
  return answer
}

async function onPath(names: string[], platform: string): Promise<string | undefined> {
  for (const name of names) {
    const file = await new Promise<string | undefined>((resolve) => {
      execFile(
        platform === "win32" ? "where.exe" : "which",
        [name],
        { windowsHide: true, timeout: 4000 },
        (error, stdout) => resolve(error ? undefined : String(stdout).split(/\r?\n/)[0]?.trim() || undefined),
      )
    })
    if (file) return file
  }
  return undefined
}

async function located(apps: OpenApp[], platform: string): Promise<Found[]> {
  const rows = await Promise.all(apps.map(async (app) => ({ id: app.id, file: await locate(app, platform) })))
  return rows.filter((row): row is Found => Boolean(row.file))
}

export async function installedOpenApps(platform: string = process.platform): Promise<string[]> {
  return (await located(openApps(platform), platform)).map((row) => row.id)
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
  return icons(await located(openApps(platform), platform), getIcon)
}

async function icons(rows: Found[], getIcon: (file: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const icon = await getIcon(row.file).catch(() => "")
    if (icon) out[row.id] = icon
  }
  return out
}

/** A delivered document's apps that are installed, in MiMo's order, with their icons; none away from macOS. */
export async function installedDocApps(
  kind: string,
  getIcon: (file: string) => Promise<string>,
  platform: string = process.platform,
): Promise<{ id: string; name: string; openWith: string; icon: string }[]> {
  const apps = docApps(kind, platform)
  const rows = await located(apps, platform)
  const drawn = await icons(rows, getIcon)
  return rows.map((row) => {
    const app = apps.find((entry) => entry.id === row.id)!
    return { id: app.id, name: app.label, openWith: app.openWith, icon: drawn[row.id] ?? "" }
  })
}

/**
 * What to start for a known app name: the bundle or program found for it, so a
 * PyCharm CE install opens as PyCharm, and Sublime Text as the program that was
 * found. The name itself when nothing was found.
 */
export async function launchTarget(openWith: string, platform: string = process.platform): Promise<string> {
  const app = launchableApps(platform).find((entry) => entry.openWith === openWith)
  // Away from macOS a plain command keeps being started by its name, as it always was.
  if (!app || (platform !== "darwin" && !app.find)) return openWith
  return (await locate(app, platform)) ?? openWith
}
