/**
 * The launcher's icon on Linux follows the one chosen in Settings, as MiMo's
 * does. The window's own icon changes at once; what a desktop's dock or app
 * grid shows comes from files, so those are rewritten:
 *
 * - run as an AppImage, the icon beside the app's own desktop entry in
 *   ~/.local/share (`icons/<id>.png`), and the entry is touched so the desktop
 *   reads it again - only when that entry exists and names that file, since
 *   MCode does not write an entry of its own;
 * - installed from a package, the entry in XDG_DATA_DIRS names a theme icon;
 *   a same-named copy in each size it ships is written to the user's hicolor
 *   theme, which is looked in first.
 *
 * Nothing is written when the bytes are already there. Kept free of Electron:
 * reading, writing and resizing are handed in, so the smoke run can use a
 * folder of its own.
 */

export interface IconSyncHost {
  platform: string
  /** APPIMAGE, when running as one. */
  appImage?: string
  home: string
  xdgDataHome?: string
  xdgDataDirs?: string
  /** CHROME_DESKTOP, which Electron sets from package.json's desktopName. */
  chromeDesktop?: string
  appName: string
  readBinary(file: string): Promise<Buffer | undefined>
  writeBinary(file: string, bytes: Buffer): Promise<void>
  readText(file: string): Promise<string | undefined>
  listDir(folder: string): Promise<string[]>
  exists(file: string): Promise<boolean>
  mkdirp(folder: string): Promise<void>
  touch(file: string): Promise<void>
  /** A square PNG of the given side. */
  resizePng(bytes: Buffer, size: number): Buffer
}

export interface IconSyncResult {
  ok: boolean
  changed: boolean
  reason: string
}

/** Paths joined with forward slashes, trailing ones trimmed: these are Linux paths wherever the check runs. */
function join(...parts: string[]): string {
  return parts
    .filter((part) => part !== "")
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .join("/")
}

function usableId(value: string): string {
  const id = value.trim().replace(/\.desktop$/, "")
  return !id || /[/\\]/.test(id) || id.includes("\0") ? "" : id
}

/** The desktop entry's id: CHROME_DESKTOP, else the app name made into one. */
export function desktopId(chromeDesktop: string | undefined, appName: string): string {
  const slug = appName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return usableId(chromeDesktop ?? "") || usableId(slug)
}

function dataHome(host: Pick<IconSyncHost, "home" | "xdgDataHome">): string {
  return (host.xdgDataHome ?? "").trim().replace(/\/+$/, "") || join(host.home, ".local", "share")
}

/** The data folders a package's entry may be in, in order, without repeats. */
export function dataDirs(raw: string | undefined): string[] {
  const listed = String(raw ?? "")
    .split(":")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean)
  return listed.length ? [...new Set(listed)] : ["/usr/local/share", "/usr/share"]
}

/** The Icon= of a desktop entry's main group, or "". */
export function entryIcon(text: string | undefined): string {
  if (!text) return ""
  let inMain = false
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("[")) {
      if (inMain) return ""
      inMain = line === "[Desktop Entry]"
      continue
    }
    if (!inMain || !line || line.startsWith("#")) continue
    const at = line.indexOf("=")
    if (at >= 0 && line.slice(0, at).trim() === "Icon") return line.slice(at + 1).trim()
  }
  return ""
}

/** A theme icon name: no path, no extension. */
function themeName(icon: string): boolean {
  return Boolean(icon) && !/[/\\\0]/.test(icon) && !/\.(png|svg|xpm)$/i.test(icon)
}

const same = (a: Buffer | undefined, b: Buffer) => Boolean(a) && a!.equals(b)
const themeIcon = (root: string, size: number, name: string) => join(root, "icons", "hicolor", `${size}x${size}`, "apps", `${name}.png`)

async function syncAppImage(host: IconSyncHost, icon: Buffer, id: string): Promise<IconSyncResult> {
  const home = dataHome(host)
  const entry = join(home, "applications", `${id}.desktop`)
  const target = join(home, "icons", `${id}.png`)
  if (entryIcon(await host.readText(entry)) !== target) return { ok: true, changed: false, reason: "skipped: no desktop entry of this app names that icon" }
  if (same(await host.readBinary(target), icon)) return { ok: true, changed: false, reason: "up to date: unchanged" }
  await host.mkdirp(join(home, "icons"))
  await host.writeBinary(target, icon)
  await host.touch(entry).catch(() => undefined)
  return { ok: true, changed: true, reason: "written" }
}

async function syncInstalled(host: IconSyncHost, icon: Buffer, id: string): Promise<IconSyncResult> {
  for (const root of dataDirs(host.xdgDataDirs)) {
    const name = entryIcon(await host.readText(join(root, "applications", `${id}.desktop`)))
    if (!name) continue
    if (!themeName(name)) return { ok: true, changed: false, reason: "skipped: the entry's icon is a file, not a theme name" }
    const sizes: number[] = []
    for (const folder of await host.listDir(join(root, "icons", "hicolor"))) {
      const match = /^(\d+)x(\d+)$/.exec(folder.trim())
      const size = match && match[1] === match[2] ? Number(match[1]) : 0
      if (size && (await host.exists(themeIcon(root, size, name)))) sizes.push(size)
    }
    if (!sizes.length) return { ok: true, changed: false, reason: "skipped: the theme has no PNG sizes for it" }
    sizes.sort((a, b) => a - b)
    const home = dataHome(host)
    const largest = sizes[sizes.length - 1]
    const top = host.resizePng(icon, largest)
    if (same(await host.readBinary(themeIcon(home, largest, name)), top)) return { ok: true, changed: false, reason: "up to date: unchanged" }
    for (const size of sizes) {
      const file = themeIcon(home, size, name)
      await host.mkdirp(file.slice(0, file.lastIndexOf("/")))
      await host.writeBinary(file, size === largest ? top : host.resizePng(icon, size))
    }
    return { ok: true, changed: true, reason: "written" }
  }
  return { ok: true, changed: false, reason: "skipped: no installed desktop entry" }
}

/** Brings the launcher's icon in line with `iconFile`; one call at a time. */
export function linuxIconSync(host: IconSyncHost): (iconFile: string) => Promise<IconSyncResult> {
  let queue: Promise<unknown> = Promise.resolve()
  const run = async (iconFile: string): Promise<IconSyncResult> => {
    if (host.platform !== "linux") return { ok: true, changed: false, reason: "skipped: not linux" }
    if (!host.home.trim()) return { ok: false, changed: false, reason: "no home folder" }
    const id = desktopId(host.chromeDesktop, host.appName)
    if (!id) return { ok: false, changed: false, reason: "no usable desktop entry id" }
    const icon = await host.readBinary(iconFile)
    if (!icon) return { ok: false, changed: false, reason: "icon source missing" }
    return host.appImage?.trim() ? syncAppImage(host, icon, id) : syncInstalled(host, icon, id)
  }
  return (iconFile) => {
    const next = queue.then(() => run(iconFile)).catch((error: unknown) => ({ ok: false, changed: false, reason: String(error) }))
    queue = next
    return next
  }
}
