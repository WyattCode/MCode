/**
 * The names a folder is judged by, before `shell.openPath` is handed one.
 *
 * `isBundleProgram` and `isProgram` are the two gates the desktop puts in front
 * of a path a page named. Both read the name written and the name the path
 * really leads to, because a link is how a `.app` - a folder that `openPath`
 * launches - reaches a channel that only judges names. Each case below is a
 * way past that gate that was open, or a file that must still open.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const EXECUTABLE = new Set([".app", ".sh", ".command", ".py", ".js"])

const findings: string[] = []
function note(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "??  "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) findings.push(name + (detail ? " - " + detail : ""))
}

const extensionOf = (file: string): string => path.extname(path.basename(file)).toLowerCase()

/* The same body as src/main/paths.ts, which imports Electron and cannot be loaded here. */
async function isBundleProgram(target: string): Promise<boolean> {
  if (EXECUTABLE.has(extensionOf(target))) return true
  try {
    return EXECUTABLE.has(extensionOf(await fs.realpath(target)))
  } catch {
    return true
  }
}

async function isProgram(target: string, stat: { mode: number }): Promise<boolean> {
  if (EXECUTABLE.has(extensionOf(target))) return true
  let real: string
  try {
    real = await fs.realpath(target)
  } catch {
    return true
  }
  if (EXECUTABLE.has(extensionOf(real))) return true
  return process.platform !== "win32" && (stat.mode & 0o111) !== 0 && !extensionOf(real)
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "mcode-names-"))
  const bundle = path.join(root, "Some App.app")
  await fs.mkdir(bundle, { recursive: true })
  await fs.writeFile(path.join(bundle, "Contents"), "", "utf8")
  const noteFile = path.join(root, "note.md")
  await fs.writeFile(noteFile, "mine", "utf8")
  const script = path.join(root, "run.sh")
  await fs.writeFile(script, "echo hi", "utf8")
  await fs.chmod(script, 0o755)
  const plain = path.join(root, "plain")
  await fs.writeFile(plain, "no extension, not executable", "utf8")

  // A link with no extension at all, pointing at the bundle: the hole this check exists for.
  const disguised = path.join(root, "innocent")
  await fs.symlink(bundle, disguised)
  // A link that keeps an ordinary extension while pointing at the bundle.
  const disguisedText = path.join(root, "notes.txt")
  await fs.symlink(bundle, disguisedText)
  // A link to an ordinary file, which must still open.
  const linkToNote = path.join(root, "link.md")
  await fs.symlink(noteFile, linkToNote)

  console.log("\nthe folder gate")
  note("a bundle by its own name is refused", await isBundleProgram(bundle))
  note("an extension-less link to a bundle is refused", await isBundleProgram(disguised))
  note("a .txt link to a bundle is refused", await isBundleProgram(disguisedText))
  note("an ordinary folder is not", !(await isBundleProgram(root)))
  note("a folder whose target cannot be read is refused, the safe side", await isBundleProgram(path.join(root, "gone", "x")))

  console.log("\nthe file gate")
  const bundleStat = await fs.stat(bundle)
  const noteStat = await fs.stat(noteFile)
  const scriptStat = await fs.stat(script)
  const plainStat = await fs.stat(plain)
  note("a bundle is a program whatever it is called", await isProgram(bundle, bundleStat))
  note("a .md file is not", !(await isProgram(noteFile, noteStat)))
  note("a link to a .md file is not", !(await isProgram(linkToNote, noteStat)))
  note("an executable script is", await isProgram(script, scriptStat))
  note("an extension-less file without the execute bits is not", !(await isProgram(plain, plainStat)))
  note("a path whose target cannot be read is refused, the safe side", await isProgram(path.join(root, "gone.txt"), plainStat))

  await fs.rm(root, { recursive: true, force: true })
  if (findings.length) {
    console.error(`\n${findings.length} case(s) behaved unexpectedly:`)
    for (const finding of findings) console.error("  " + finding)
    process.exit(1)
  }
  console.log("\nNeither name reaches the shell unjudged.")
  process.exit(0)
}

void main()
