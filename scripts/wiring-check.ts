/**
 * Controls that are wired in more than one place, and so can come unwired.
 *
 * Nothing here is about behaviour. It is about the seams where a feature is
 * declared in one file and consumed in another, because those are the failures
 * that no type checker sees and no screenshot shows: the control is drawn, it
 * takes the click, and the click arrives nowhere.
 *
 * Two seams have failed this way already - the menu's channels, where the whole
 * Go menu was dead, and a component's events, where the home screen's "Edit
 * project" reached a parent that was not listening.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const problems: string[] = []
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8")

// ---------------------------------------------------------------- menu items
/*
 * A menu command is written in three places: the menu builds the item and sends
 * a channel, the preload forwards that channel, and the renderer has a handler.
 * Miss the middle one and nothing reports a problem - the item appears, the
 * accelerator binds, the click sends, and it arrives nowhere.
 */
const menuSource = read("src/main/menu.ts")
const preloadSource = read("src/preload/index.ts")
const appSource = read("src/renderer/src/App.vue")

const sent = new Set([...menuSource.matchAll(/send\("menu:([a-z-]+)"\)/g)].map((match) => match[1]))
const forwardedBlock = preloadSource.slice(preloadSource.indexOf("const commands = ["))
const forwarded = new Set(
  [...forwardedBlock.slice(0, forwardedBlock.indexOf("]")).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]),
)
const handlerBlock = appSource.slice(appSource.indexOf("const menuCommands"))
const handled = handlerBlock.slice(0, handlerBlock.indexOf("\n}"))

for (const command of sent) {
  if (!forwarded.has(command)) {
    problems.push(`menu:${command} is sent by the menu but the preload does not forward it`)
    continue
  }
  // Keys are written bare when they need no quotes, quoted when they do.
  if (!handled.includes(`\n  ${command}:`) && !handled.includes(`"${command}":`)) {
    problems.push(`menu:${command} is forwarded but the renderer has no handler`)
  }
}
for (const command of forwarded) {
  if (!sent.has(command)) problems.push(`the preload forwards menu:${command}, which no menu item sends`)
}
console.log(`menu commands: ${sent.size}`)

// --------------------------------------------------- guards that name a command
/*
 * Two tables in App.vue map a menu item or a keyboard chord to the id of the
 * command that decides whether it can run. A typo in either is silent in the
 * worst possible direction: the lookup finds nothing, "is this disabled" answers
 * no, and the guard quietly stops guarding while every id around it still works.
 */
for (const table of ["MENU_COMMAND_IDS", "KEY_COMMAND_IDS"]) {
  const at = appSource.indexOf(`const ${table}`)
  if (at === -1) {
    problems.push(`App.vue no longer declares ${table}, which the menu and keyboard guards read`)
    continue
  }
  const body = appSource.slice(at, appSource.indexOf("\n}", at))
  const ids = [...body.matchAll(/:\s*"([\w.]+)"/g)].map((match) => match[1])
  if (!ids.length) problems.push(`${table} names no commands, so nothing is guarded`)
  for (const id of ids) {
    if (!appSource.includes(`id: "${id}"`)) {
      problems.push(`${table} points at "${id}", which is not a command - that guard does nothing`)
    }
  }
}

// ------------------------------------------------------- what the window may reach
/*
 * The content policy and the code have to agree about what the window can talk
 * to, and neither one reports a disagreement: a request the policy forbids does
 * not raise an error the caller can catch, it just never happens. Two features
 * were dead this way at once - the update check, whose fetch could not leave the
 * process, and every remote server, because the policy named the literal
 * 127.0.0.1 and so refused even ws://localhost.
 */
const html = read("src/renderer/index.html")
const policy = /content="(default-src[^"]*)"/.exec(html)?.[1] ?? ""
const connect = /connect-src ([^;"]*)/.exec(policy)?.[1] ?? ""

if (!connect) {
  problems.push("index.html declares no connect-src, so what the window may reach is unstated")
} else {
  /*
   * MCode offers to connect to a server on another machine, so the policy has to
   * allow a socket to one. Compared token by token rather than by searching the
   * whole line: "ws:" is a substring of "ws://127.0.0.1:*", so a search finds
   * the scheme in exactly the host-limited source this is meant to reject.
   */
  const sources = connect.trim().split(/\s+/)
  if (!sources.includes("ws:") && !sources.includes("wss:")) {
    problems.push(
      `connect-src allows no socket scheme, only ${sources.join(" ")} - so no server but the one on that exact address can be reached`,
    )
  }
  /*
   * The other direction. http and https are deliberately not reachable from the
   * window, which is what keeps rendered model output from being able to cause a
   * request - so nothing in the renderer may use an API that needs them. The one
   * thing that did was moved to the main process.
   */
  if (!/\bhttps?:/.test(connect)) {
    const walkFiles = (directory: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) walkFiles(full, out)
        else if (/\.(vue|ts)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    for (const file of walkFiles(path.join(root, "src/renderer/src"))) {
      const text = fs.readFileSync(file, "utf8")
      for (const api of ["fetch(", "new XMLHttpRequest", "new EventSource"]) {
        // `prefetch(` and `refetch(` are ordinary names, not the global.
        const found = api === "fetch(" ? /(?<![A-Za-z.])fetch\(/.test(text) : text.includes(api)
        if (found) {
          problems.push(
            `${path.relative(root, file).replace(/\\/g, "/")} uses ${api.replace(/[(]$/, "")}, which connect-src forbids - it belongs in the main process`,
          )
        }
      }
    }
  }
}

// ------------------------------------------------------------ component events
/*
 * An event a component raises that nobody anywhere binds. Vue is content to
 * emit into the void, so a button wired to `emit("edit")` looks completely
 * ordinary in the child and does nothing at all in the app.
 *
 * A component used in several places may reasonably be bound in one and not
 * another - a popover that also renders docked, say - so an event only counts
 * as dead when no usage site anywhere binds it.
 */
const componentDir = path.join(root, "src/renderer/src/components")
const componentFiles = fs.readdirSync(componentDir).filter((name) => name.endsWith(".vue"))
/* The right panel's tabs live in a folder of their own, and mount components as any other does. */
const rightFiles = fs
  .readdirSync(path.join(componentDir, "right"))
  .filter((name) => name.endsWith(".vue"))
  .map((name) => path.join("right", name))

/** Everywhere a component could be used, including other components. */
const consumers = [
  appSource,
  ...componentFiles.map((name) => fs.readFileSync(path.join(componentDir, name), "utf8")),
  ...rightFiles.map((name) => fs.readFileSync(path.join(componentDir, name), "utf8")),
  ...fs
    .readdirSync(path.join(componentDir, "parts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".vue"))
    .map((entry) => fs.readFileSync(path.join(componentDir, "parts", entry.name), "utf8")),
]

/**
 * Where a tag ends.
 *
 * Not the first `>`: handlers are written inline, so `@edit="(dir) => (...)"`
 * puts a greater-than inside an attribute value. Cutting there truncated the
 * tag and reported every binding after it as missing.
 */
function tagEnd(source: string, from: number): number {
  let quote = ""
  for (let i = from; i < source.length; i += 1) {
    const character = source[i]
    if (quote) {
      if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ">") return i
  }
  return source.length
}

let checkedEvents = 0
for (const file of [...componentFiles, ...rightFiles]) {
  const name = path.basename(file).replace(/\.vue$/, "")
  const source = fs.readFileSync(path.join(componentDir, file), "utf8")

  // What the component actually raises, rather than what it declares: a
  // declared-but-unraised event is untidy, not broken.
  const raised = new Set([...source.matchAll(/\bemit\(\s*["']([a-zA-Z-]+)["']/g)].map((m) => m[1]))
  if (!raised.size) continue

  // Every tag that mounts this component, anywhere.
  const tags: string[] = []
  for (const consumer of consumers) {
    const opening = new RegExp(`<${name}(?=[\\s/>])`, "g")
    for (const match of consumer.matchAll(opening)) {
      const from = match.index ?? 0
      tags.push(consumer.slice(from, tagEnd(consumer, from)))
    }
  }
  if (!tags.length) continue

  for (const event of raised) {
    checkedEvents += 1
    const bound = tags.some(
      (tag) => tag.includes(`@${event}=`) || tag.includes(`@${event}.`) || tag.includes(`v-on:${event}`),
    )
    if (bound) continue
    problems.push(`${file} raises "${event}" but no parent binds @${event}`)
  }
}
console.log(`component events checked: ${checkedEvents}`)

// ------------------------------------------------------- the context-usage ring
/*
 * One ring, drawn at two sizes.
 *
 * The session header and the Context tab show the same figure, and the
 * reference deliberately draws them at different geometries - 14px on a 1.5
 * stroke in the header, 16px on a 2 stroke in the tab. That is the seam: the
 * obvious way to reuse the header's ring in the tab is to mount it as it
 * stands, which produces a ring that is the wrong size by two pixels and looks
 * entirely correct in every screenshot of either one on its own. The other
 * failure is the opposite - someone inlines a second copy of the SVG rather
 * than mounting the component, and the two drift.
 */
const ringSource = (() => {
  const file = path.join(componentDir, "ContextRing.vue")
  if (!fs.existsSync(file)) {
    problems.push("ContextRing.vue is gone, so the ring the composer and the Context tab share has no home")
    return ""
  }
  return fs.readFileSync(file, "utf8")
})()

if (ringSource) {
  // The arc is wound back by an offset rather than redrawn, which is the whole
  // reason it animates; a ring without this is a ring that jumps.
  if (!ringSource.includes("stroke-dashoffset")) {
    problems.push("ContextRing.vue draws no stroke-dashoffset, so its arc cannot show a fraction")
  }
  // Every other component must go through it. `stroke-dashoffset` appears
  // nowhere else in the renderer, which makes it an exact marker for a
  // hand-rolled second copy.
  for (const file of componentFiles) {
    if (file === "ContextRing.vue") continue
    const source = fs.readFileSync(path.join(componentDir, file), "utf8")
    if (source.includes("stroke-dashoffset")) {
      problems.push(`${file} draws its own progress ring instead of mounting ContextRing`)
    }
  }
}

/*
 * Both call sites, with the geometry each one is supposed to have. The composer
 * draws MiMo's 18px ring on a 2.4 stroke. The header held one too until it took
 * MiMo's bottom panel toggle in that place instead, and the review panel's Context
 * tab went with that panel.
 */
const ringSites: [string, string[]][] = [
  ["Composer.vue", ["<ContextRing", ':size="18"', ':stroke="2.4"']],
]
for (const [file, needles] of ringSites) {
  const source = fs.readFileSync(path.join(componentDir, file), "utf8")
  for (const needle of needles) {
    if (source.includes(needle)) continue
    problems.push(`${file} does not mount the context ring with ${needle}`)
  }
}

console.log("context ring: checked")

// -------------------------------------------------------- unreachable backend
/*
 * A request the backend answers that nothing in the interface ever asks.
 *
 * `workspace.remove` sat like this: the protocol declared it, the server
 * handled it, and no control anywhere sent it - so a workspace could be created
 * and never removed, and nothing said so. A type checker cannot see it, because
 * both halves are individually correct; only the absence of a caller is wrong.
 *
 * The match is on `type: "x"` rather than on the name, because command ids
 * reuse these names. The first version of this check looked for the bare string
 * and reported everything as reachable - including, when tested, a request
 * whose only caller had just been deleted.
 */
{
  const protocol = read("src/shared/protocol.ts")
  const union = protocol.slice(
    protocol.indexOf("export type Request ="),
    protocol.indexOf("export type RequestType"),
  )
  const declared = [...union.matchAll(/\|\s*\{\s*type:\s*"([\w.]+)"/g)].map((m) => m[1])

  const files: string[] = []
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (next.endsWith(".ts") || next.endsWith(".vue")) files.push(next)
    }
  }
  walk("src/renderer")
  const renderer = files.map((file) => read(file)).join("\n")

  for (const name of declared) {
    if (new RegExp(`type:\\s*"${name.replace(".", "\\.")}"`).test(renderer)) continue
    problems.push(`the backend answers ${name} and nothing in the interface sends it`)
  }
  console.log(`backend requests: ${declared.length}, all reachable from the interface`)

  /*
   * A setting nothing reads.
   *
   * `showReasoning` had a switch in settings, a default in the config and a
   * field in the protocol - and no reader anywhere, so turning it off did
   * nothing at all and changing its default did nothing either. The switch
   * still moved, which is what made it invisible: it looked like a working
   * setting from every side except the one that mattered.
   *
   * A setting is read when something other than the settings dialog and the
   * defaults mentions it. Writing it back does not count as reading it, so the
   * dialog's own `patchConfig({ x: !config?.x })` is excluded along with the
   * dialog itself.
   */
  const config = read("src/shared/protocol.ts")
  const block = config.slice(config.indexOf("export interface AppConfig"))
  const END = String.fromCharCode(10) + "}"
  const fields = [...block.slice(0, block.indexOf(END)).matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1])
  /*
   * The backend counts as a reader. A permission or a shell setting is acted on
   * where the work happens, not in the window - `autoApprove` is read only in
   * `src/server/config.ts`, and scanning the renderer alone reported it dead.
   */
  const backend: string[] = []
  for (const area of ["src/server", "src/main"]) {
    const collect = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const next = `${relative}/${entry.name}`
        if (entry.isDirectory()) collect(next)
        else if (next.endsWith(".ts")) backend.push(next)
      }
    }
    collect(area)
  }
  /*
   * Declaring a default is not reading one either.
   *
   * Counting the backend as a reader is right - a permission is acted on where
   * the work happens - but `defaults()` lives in the backend too, and every
   * field is named there exactly once, by definition. Left in, it satisfied
   * every field and the check could not fail for any of them. It did not fail
   * for a field whose renderer-side reader had been deleted, which is how this
   * was found: by deleting one and watching the check pass anyway.
   */
  const defaultsBody = (source: string) => {
    const start = source.indexOf("function defaults(): AppConfig {")
    if (start === -1) return ""
    const end = source.indexOf(String.fromCharCode(10) + "}", start)
    return end === -1 ? source.slice(start) : source.slice(start, end)
  }
  const texts = [...files.filter((file) => !file.endsWith("SettingsDialog.vue")), ...backend].map((file) => {
    const source = read(file)
    const body = defaultsBody(source)
    return body ? source.split(body).join("") : source
  })
  const readers = texts.join(String.fromCharCode(10))
  /*
   * Only a read counts as a read.
   *
   * This used to accept the field's name as a whole word anywhere, and a word
   * is not a read: `showTerminal` had no reader at all, yet the command table's
   * string key "cmd.showTerminal" satisfied it, and names as common as `shell`,
   * `theme` or `model` could hardly fail. A field is read now only as a property
   * access (`.field`, `?.field`, `["field"]`) or by destructuring
   * (`{ field } = ...`), and dotted string keys - an i18n key, a command id -
   * are blanked out first. A Vue binding is a quoted expression too, so a
   * quoted string straight after `=` is left alone.
   */
  const BACKSLASH = String.fromCharCode(92)
  const keyLike = new RegExp(`(^|[^=])(["'])[A-Za-z_][${BACKSLASH}w-]*(?:${BACKSLASH}.[${BACKSLASH}w-]+)+${BACKSLASH}2`, "g")
  const accessible = readers.replace(keyLike, "$1$2$2")
  const isRead = (field: string) =>
    new RegExp(`${BACKSLASH}.${field}(?![${BACKSLASH}w$])`).test(accessible) ||
    new RegExp(`${BACKSLASH}[${BACKSLASH}s*["']${field}["']${BACKSLASH}s*${BACKSLASH}]`).test(readers) ||
    new RegExp(`${BACKSLASH}{[^{}]*${BACKSLASH}b${field}${BACKSLASH}b[^{}]*${BACKSLASH}}${BACKSLASH}s*=(?![=>])`).test(accessible)
  const unread = fields.filter((field) => !isRead(field))
  for (const field of unread) {
    problems.push(`the config carries ${field} and nothing outside settings reads it`)
  }
  console.log(`config fields: ${fields.length}, each read somewhere other than the settings dialog`)
}

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("\nEvery menu item reaches a handler, and every event a component raises is bound.")
