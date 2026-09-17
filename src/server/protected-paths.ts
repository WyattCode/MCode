import os from "node:os"
import path from "node:path"

/**
 * The folders a walk from the home folder stays out of, as MiMo's engine
 * lists them: on macOS each of these is behind a privacy prompt (photos,
 * contacts, calendars, mail), so a file search that wanders in raises a
 * dialog per folder; on Windows they are large and seldom what is meant.
 * Only a walk whose project is the home folder itself skips them.
 */
const DARWIN_HOME = ["Music", "Pictures", "Movies", "Downloads", "Desktop", "Documents", "Public", "Applications", "Library"]
const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]
const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

/** The protected folders under a home folder, as full paths. */
export function protectedPaths(platform: string, home: string): string[] {
  const join = platform === "win32" ? path.win32.join : path.posix.join
  if (platform === "darwin") return [...DARWIN_HOME.map((name) => join(home, name)), ...DARWIN_LIBRARY.map((name) => join(home, "Library", name))]
  if (platform === "win32") return WIN32_HOME.map((name) => join(home, name))
  return []
}

const fold = (platform: string, file: string) => (platform === "win32" ? path.win32.normalize(file).toLowerCase() : path.posix.normalize(file))

/**
 * A test for the folders a walk rooted at `root` must not enter; one that
 * passes nothing when the root is not the home folder.
 */
export function protectedFilter(root: string, platform: string = process.platform, home: string = os.homedir()): (folder: string) => boolean {
  if (fold(platform, root) !== fold(platform, home)) return () => false
  const skipped = new Set(protectedPaths(platform, home).map((file) => fold(platform, file)))
  return (folder) => skipped.has(fold(platform, folder))
}
