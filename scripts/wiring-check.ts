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

/** Everywhere a component could be used, including other components. */
const consumers = [
  appSource,
  ...componentFiles.map((name) => fs.readFileSync(path.join(componentDir, name), "utf8")),
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

/*
 * Events raised only from a mode nothing mounts.
 *
 * ProjectPanel can render docked, as a popover or as a bare menu, and it raises
 * "close" only when it is floating - `if (floating.value) emit("close")`. The
 * app mounts it docked and nowhere else, so the event cannot fire. That is an
 * unused mode rather than a control that does nothing, and it is written down
 * here so the check keeps reporting the failures that matter. If the floating
 * modes are ever mounted, the binding has to come with them; if they are
 * removed, this line goes too.
 */
const UNMOUNTED_MODES = new Set(["ProjectPanel.vue:close"])

let checkedEvents = 0
for (const file of componentFiles) {
  const name = file.replace(/\.vue$/, "")
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
    if (bound || UNMOUNTED_MODES.has(`${file}:${event}`)) continue
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
    problems.push("ContextRing.vue is gone, so the ring the header and the Context tab share has no home")
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
 * Both call sites, with the geometry each one is supposed to have. The header
 * passes neither prop and takes the component's 14/1.5 defaults; the tab has to
 * ask for 16/2, so that is what is checked for.
 */
const ringSites: [string, string[]][] = [
  ["SessionHeader.vue", ["<ContextRing"]],
  ["FilePanel.vue", ["<ContextRing", ':size="16"', ':stroke="2"']],
]
for (const [file, needles] of ringSites) {
  const source = fs.readFileSync(path.join(componentDir, file), "utf8")
  for (const needle of needles) {
    if (source.includes(needle)) continue
    problems.push(`${file} does not mount the context ring with ${needle}`)
  }
}

// ------------------------------------------------------------ the large-diff guard
/*
 * A guard that shows its message and renders anyway is not a guard.
 *
 * The expensive half is the parse and the DOM, not the sentence, so the check
 * is that `rows` actually refuses - and that the escape hatch is still there,
 * because a refusal with no way through is the reader unable to see their own
 * diff.
 */
const patchSource = fs.readFileSync(path.join(componentDir, "ReviewPatch.vue"), "utf8")
if (!/const MAX_CHANGED_LINES = 500\b/.test(patchSource)) {
  problems.push("ReviewPatch.vue no longer sets the reference's 500-changed-line limit")
}
if (!/if \(tooLarge\.value\) return \[\]/.test(patchSource)) {
  problems.push("ReviewPatch.vue shows the large-diff message but still parses the diff behind it")
}
/*
 * The button has to be wired, not merely labelled.
 *
 * Searching for the bare word "renderAnyway" was the first attempt and it was a
 * check that could not fail: the i18n key is
 * `ui.sessionReview.largeDiff.renderAnyway`, so the word is in the file whether
 * or not anything handles the click. Both halves of the seam are named here
 * instead - the handler and the binding that reaches it.
 */
if (!/function renderAnyway\b/.test(patchSource)) {
  problems.push("ReviewPatch.vue has no renderAnyway handler, so a large diff cannot be forced open")
}
if (!/@click="renderAnyway"/.test(patchSource)) {
  problems.push("ReviewPatch.vue's Render anyway button is not wired to renderAnyway")
}

/*
 * No `---` / `+++` test inside the hunk loop, in either the parser or the
 * counter.
 *
 * Both loops throw away everything before the first `@@`, and git writes the
 * two file headers before it, so past that point such a test can only match a
 * real changed line whose own text begins `--` or `++`. Driven in the app while
 * the test was still there: a patch that deleted `-- a sql comment` and added
 * `++i;` drew neither row and then numbered the rest of the hunk one short, so
 * a review note filed against the last line landed on the one above it.
 *
 * Written as "the strings do not appear anywhere in the file" rather than as a
 * regex over the loop, because the failure mode being guarded is somebody
 * re-adding the skip, and it can be re-added in either loop or in a helper.
 */
for (const header of ['startsWith("---")', 'startsWith("+++")']) {
  if (!patchSource.includes(header)) continue
  problems.push(
    `ReviewPatch.vue tests ${header} past the first hunk, which drops changed lines whose own text begins -- or ++`,
  )
}

/*
 * The reference has exactly three strings in this family - title, meta and
 * renderAnyway - and no fourth. A `.description` or a `.button` invented to fill
 * out the block would be a hand-written string wearing a reference key's name,
 * which is the one thing no locale check can catch: it would be present in all
 * 18 tables and defined, and simply not be the reference's.
 */
const LARGE_DIFF_KEYS = ["title", "meta", "renderAnyway"]
for (const leaf of LARGE_DIFF_KEYS) {
  if (patchSource.includes(`ui.sessionReview.largeDiff.${leaf}`)) continue
  problems.push(`ReviewPatch.vue does not use ui.sessionReview.largeDiff.${leaf}`)
}
for (const used of patchSource.matchAll(/ui\.sessionReview\.largeDiff\.([A-Za-z]+)/g)) {
  if (LARGE_DIFF_KEYS.includes(used[1])) continue
  problems.push(
    `ReviewPatch.vue reads ui.sessionReview.largeDiff.${used[1]}, which the reference does not have`,
  )
}

/*
 * The Context tab's x says "Close tab", not "Close".
 *
 * Two different strings that both exist and both read plausibly, which is why
 * this went unnoticed: `common.close` is defined in all 18 tables, so no locale
 * check has anything to report about it.
 */
/*
 * Both the name it is announced by and the name it is shown by, because the
 * reference uses the key for both - `aria-label` and the tooltip title on the
 * same control. Looking for the key anywhere in the block was the first
 * attempt, and it passed with the aria-label changed back to `common.close`,
 * because the tooltip beside it still carried the word.
 */
const panelSource = fs.readFileSync(path.join(componentDir, "FilePanel.vue"), "utf8")
const closeBlock = panelSource.slice(panelSource.indexOf('class="tab-close"'), panelSource.indexOf('class="tab-close"') + 400)
for (const [attribute, pattern] of [
  ["aria-label", /:aria-label="t\('common\.closeTab'\)"/],
  ["tooltip", /v-tip="\{ label: t\('common\.closeTab'\)/],
] as [string, RegExp][]) {
  if (pattern.test(closeBlock)) continue
  problems.push(`FilePanel.vue's Context tab close does not take its ${attribute} from common.closeTab`)
}
console.log("context ring and review guard: checked")

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
}

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("\nEvery menu item reaches a handler, and every event a component raises is bound.")
