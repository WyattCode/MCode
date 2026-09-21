/**
 * The boundary between the project and everything else.
 *
 * resolvePath decides whether a model-supplied path needs the user's approval,
 * and allowsOutside decides whether an approval already covers it. Both compare
 * paths lexically, which is right for the ordinary cases and is exactly the kind
 * of test that a symlink or a name that happens to share a prefix walks through.
 *
 * Each case says what a person would expect, so a surprise is legible as a
 * finding rather than as a number.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { resolvePath } from "../src/server/tool/fs-util"
import { FILE_MANAGER_ID, isKnownOpenWith, openApps } from "../src/shared/open-app"

const findings: string[] = []
function note(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "??  "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) findings.push(name + (detail ? " - " + detail : ""))
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-gate-"))
  const project = path.join(root, "project")
  const sibling = path.join(root, "projectile")
  const outside = path.join(root, "outside")
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(sibling, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(sibling, "secret.txt"), "next door", "utf8")
  await fs.writeFile(path.join(outside, "secret.txt"), "elsewhere", "utf8")
  await fs.writeFile(path.join(project, "own.txt"), "mine", "utf8")

  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  // A stored config, so the checks run at the default level rather than a first install's 帮我审批.
  await storage.write("config", {})
  await config.load()
  const permissions = new Permissions(bus, config)

  /**
   * One answerer, whose reply is switchable. Two subscribers both responding
   * means the first reply wins and the second is ignored, which reads as the
   * gate misbehaving.
   */
  let asked = 0
  let answer: "reject" | "always" = "reject"
  bus.subscribe((event) => {
    if (event.type !== "permission.requested") return
    asked += 1
    const request = (event as { request: { id: string } }).request
    setTimeout(() => permissions.respond(request.id, answer), 0)
  })

  const context = {
    sessionID: "s1",
    messageID: "m1",
    callID: "c1",
    directory: project,
    permissions,
  } as never

  /** True when the path was allowed through without asking. */
  const silentlyAllowed = async (target: string): Promise<boolean> => {
    const before = asked
    try {
      await resolvePath(context, target)
      return asked === before
    } catch {
      return false
    }
  }

  console.log("the project boundary")
  note("its own file needs no approval", await silentlyAllowed(path.join(project, "own.txt")))
  note(
    "a sibling whose name merely starts the same is not inside",
    !(await silentlyAllowed(path.join(sibling, "secret.txt"))),
    `${path.basename(project)} vs ${path.basename(sibling)}`,
  )
  note("an unrelated directory is not inside", !(await silentlyAllowed(path.join(outside, "secret.txt"))))
  note(
    "a path that walks out and back in is inside",
    await silentlyAllowed(path.join(project, "..", "project", "own.txt")),
  )

  // A junction is the one kind of link Windows makes without elevation.
  let linked = true
  const link = path.join(project, "link")
  try {
    await fs.symlink(outside, link, "junction")
  } catch {
    linked = false
  }
  if (linked) {
    const throughLink = await silentlyAllowed(path.join(link, "secret.txt"))
    note(
      "a link inside the project pointing out of it still asks",
      !throughLink,
      throughLink ? "reached " + outside + " with no prompt" : "",
    )
  } else {
    console.log("  --   could not create a junction here; link case not exercised")
  }

  console.log("what an approval covers")
  const session = "s2"
  const approved = { ...(context as object), sessionID: session } as never
  answer = "always"
  await resolvePath(approved, path.join(outside, "secret.txt")).catch(() => undefined)
  answer = "reject"

  // Approvals are kept per project, as MiMo's engine keeps them, and name the folder a path sits in.
  const here = { directory: project, sessionID: session }
  note("that directory no longer asks", permissions.allowsOutside(here, outside))
  note("nor a folder below it", permissions.allowsOutside(here, path.join(outside, "deeper")))
  note("a sibling sharing its prefix is not covered", !permissions.allowsOutside(here, path.join(root, "outsider")))
  note("an unrelated path is not covered", !permissions.allowsOutside(here, sibling))
  note("another conversation in the same project is covered", permissions.allowsOutside({ directory: project, sessionID: "s3" }, outside))
  note("another project is not covered", !permissions.allowsOutside({ directory: sibling, sessionID: "s3" }, outside))

  console.log("")
  console.log("\nwhich applications a window may start")
  {
    /*
     * "Open in" hands the main process an application name, and the main
     * process runs it. The reference passes whatever its window sends straight
     * to execFile, because it treats its own renderer as trusted; this app does
     * not, so the name is checked against the table on the way in. A page that
     * has been talked into asking for something else must get nothing.
     */
    note("the five apps the table names may be started", isKnownOpenWith("code", "win32") && isKnownOpenWith("cursor", "win32") && isKnownOpenWith("zed", "win32") && isKnownOpenWith("powershell", "win32") && isKnownOpenWith("subl", "win32") && !isKnownOpenWith("Sublime Text", "win32"))

    // The default choice has no application at all - it goes to the desktop.
    note("the file manager is not a name that can be started", !isKnownOpenWith(FILE_MANAGER_ID, "win32"), FILE_MANAGER_ID)

    for (const asked of ["cmd", "notepad", "curl", "powershell.exe", "code.exe", "Code", "CURSOR"]) {
      note(`a name outside the table is refused: ${asked}`, !isKnownOpenWith(asked, "win32"))
    }

    // The shapes an attacker reaches for first, none of which is a string in
    // the table and all of which would otherwise reach execFile.
    for (const asked of [
      "code; calc",
      "code && calc",
      "../../Windows/System32/cmd.exe",
      "C:/Windows/System32/cmd.exe",
      "",
      " code",
      "code ",
    ]) {
      note(`nor a decorated one: ${JSON.stringify(asked)}`, !isKnownOpenWith(asked, "win32"))
    }

    for (const asked of [undefined, null, 0, 1, true, {}, [], { toString: () => "code" }]) {
      note(`nor a non-string: ${JSON.stringify(asked) ?? String(asked)}`, !isKnownOpenWith(asked, "win32"))
    }

    // Every label the table offers must be a real string key, or the menu draws
    // a raw identifier where opencode draws an application's name.
    const everywhere = [...openApps("win32"), ...openApps("darwin"), ...openApps("linux")]
    const missing = everywhere.filter((entry) => !entry.label.startsWith("session.header.open.app."))
    note("every app carries a reference string key", missing.length === 0, missing.map((entry) => entry.id).join(", "))

    /*
     * The tables at MiMo's sizes (round ten, M10-16 / M10-19): Windows keeps
     * the five, macOS is Terminal and MiMo's nineteen, and Linux is empty,
     * because MiMo looks only for macOS application bundles.
     */
    note("windows offers the five", openApps("win32").length === 5)

    /*
     * And one platform's names are not another's. The macOS table sends bundle
     * names to `open -a`; away from macOS the same string goes to `execFile`
     * as a command on PATH, so a window that asked Windows to start "Xcode"
     * must be refused even though the name is in a table somewhere.
     */
    const elsewhere = ["Xcode", "Terminal", "Ghostty", "Visual Studio Code"]
    for (const asked of elsewhere) {
      note(`a macos-only name is refused on windows: ${asked}`, !isKnownOpenWith(asked, "win32"))
      note(`and accepted on macos: ${asked}`, isKnownOpenWith(asked, "darwin"))
    }
    note("a windows-only name is refused on macos", !isKnownOpenWith("powershell", "darwin"))
    // The document apps a delivered file offers are macOS names too.
    note("a macos document app is refused on windows", !isKnownOpenWith("Keynote", "win32") && !isKnownOpenWith("Microsoft Word", "linux"))
    note("and accepted on macos", isKnownOpenWith("Keynote", "darwin") && isKnownOpenWith("WPS Office", "darwin"))
    note("macos offers terminal and MiMo's nineteen", openApps("darwin").length === 20)
    note("linux offers none, as MiMo finds none there", openApps("linux").length === 0)
    note("so nothing can be started by name on linux", !isKnownOpenWith("code", "linux") && !isKnownOpenWith("subl", "linux"))

    /* An unrecognised platform falls to the Linux list, as the reference's `apps()` does. */
    note("an unknown platform falls to linux", openApps("freebsd").length === openApps("linux").length)
  }

  if (findings.length) {
    console.error(`${findings.length} case(s) behaved unexpectedly:`)
    for (const finding of findings) console.error("  " + finding)
    process.exit(1)
  }
  console.log("The boundary holds for every case tested.")
  process.exit(0)
}

void main()
