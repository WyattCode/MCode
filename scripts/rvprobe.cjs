/**
 * Drives the review panel the way a person does - real mouse and key events
 * through the window, not element.click() - because the question being asked
 * is partly about focus, and focus is decided by which device did the acting.
 *
 * Run with: npx electron scratchpad/rvprobe.cjs
 */
const path = require("node:path")
const fs = require("node:fs")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow } = require("electron")

/*
 * Everything the probe writes, and the throwaway repository it reviews, live
 * under out/ so a checkout on any machine can run this.
 */
const SCRATCH = path.join(__dirname, "..", "out", "rvprobe")
const REPO = path.join(SCRATCH, "repo")
const errors = []

app.commandLine.appendSwitch("disable-gpu")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const NL = String.fromCharCode(10)
fs.mkdirSync(SCRATCH, { recursive: true })

const mark = (text) => {
  try { fs.appendFileSync(path.join(SCRATCH, "rvtrace.txt"), text + NL) } catch {}
}

/**
 * A repository with one file of each kind: edited, deleted, added, and one
 * long enough that widening the context has something to widen into.
 */
function buildRepo() {
  const { execFileSync } = require("node:child_process")
  const git = (...args) => execFileSync("git", args, { cwd: REPO, windowsHide: true })
  fs.rmSync(REPO, { recursive: true, force: true })
  fs.mkdirSync(path.join(REPO, "src"), { recursive: true })

  const wide = (changed) =>
    Array.from({ length: 40 }, (_, i) => (changed && i === 20 ? "export const changed = 999" : `export const v${i} = ${i}`)).join(NL) + NL

  fs.writeFileSync(path.join(REPO, "src", "b.ts"), "export const kept = 1" + NL + "export const gone = 2" + NL)
  fs.writeFileSync(path.join(REPO, "src", "new.ts"), "export const doomed = true" + NL)
  fs.writeFileSync(path.join(REPO, "src", "wide.ts"), wide(false))
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-q", "-m", "base")

  fs.writeFileSync(path.join(REPO, "src", "b.ts"), "export const kept = 1" + NL + "export const edited = 42" + NL)
  fs.rmSync(path.join(REPO, "src", "new.ts"))
  fs.writeFileSync(path.join(REPO, "src", "fresh.ts"), "export const fresh = true" + NL)
  fs.writeFileSync(path.join(REPO, "src", "wide.ts"), wide(true))
}

app.whenReady().then(async () => {
  mark("ready")
  buildRepo()
  await import(pathToFileURL(path.join(__dirname, "..", "out", "main", "index.js")).href)

  const window = await new Promise((resolve) => {
    const poll = setInterval(() => {
      const found = BrowserWindow.getAllWindows()[0]
      if (found) {
        clearInterval(poll)
        resolve(found)
      }
    }, 100)
  })
  mark("window found")
  window.setSize(1400, 950)
  window.show()
  window.focus()
  window.moveTop()
  window.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })
  await wait(4000)
  mark("waited")

  const js = (code) => window.webContents.executeJavaScript(code)
  const lines = []
  /*
   * Written to a file rather than logged: Electron's main process on Windows
   * has no console attached when it is launched from a pipe, so every finding
   * would otherwise land nowhere.
   */
  const say = (label, value) => {
    lines.push(label + ": " + value)
    fs.writeFileSync(path.join(SCRATCH, "rvprobe.txt"), lines.join(NL))
  }

  const shoot = async (name) => {
    await wait(400)
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(SCRATCH, name + ".png"), image.toPNG())
  }

  /**
   * A real click at a point, so focus-visible resolves the way it would live.
   *
   * The window has to be the focused one: Electron routes synthesised input
   * through the same path as the real device, and an unfocused window is not
   * where the real device would be pointing.
   */
  /*
   * Input is addressed in the window's own pixels, but getBoundingClientRect
   * answers in CSS pixels - and the app carries a zoom factor between the two.
   * Sending a rect straight back put every click ~9% short of where it was
   * aimed, which looked exactly like clicks not working at all.
   */
  const toWindow = (value) => Math.round(value * window.webContents.getZoomFactor())

  const clickAt = async (cssX, cssY) => {
    const x = toWindow(cssX)
    const y = toWindow(cssY)
    window.webContents.sendInputEvent({ type: "mouseMove", x, y })
    await wait(60)
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 })
    await wait(60)
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 })
    await wait(350)
  }

  const centre = async (selector, index) => {
    const box = JSON.parse(
      await js(`(() => {
        const all = document.querySelectorAll(${JSON.stringify(selector)})
        const el = all[${index ?? 0}]
        if (!el) return "null"
        const r = el.getBoundingClientRect()
        return JSON.stringify([Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)])
      })()`),
    )
    return box
  }

  mark("about to create")
  // ---------------------------------------------------------- open a repo --
  /*
   * Started rather than awaited: create() only settles once the session is
   * fully live, and a probe that waits on it has no way to report that it is
   * waiting. Poll for the thing being probed instead.
   */
  await js(`(() => {
    const store = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app")
    window.__probe = store.create(${JSON.stringify(REPO)}).then(() => "ok", (e) => "failed: " + e.message)
    return "started"
  })()`)
  for (let tries = 0; tries < 30; tries += 1) {
    const state = await js(`(() => {
      const store = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app")
      return JSON.stringify({ id: store.currentID || null, dir: store.current && store.current.directory })
    })()`)
    say("waiting for the session", state)
    if (JSON.parse(state).id) break
    await wait(700)
  }

  /*
   * The panel is open by default, so pressing its shortcut would have closed
   * it - which is exactly what the first run of this probe did, and why it
   * then found nothing to measure.
   */
  for (let tries = 0; tries < 20; tries += 1) {
    if (await js(`Boolean(document.querySelector(".panel"))`)) break
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "\\", modifiers: ["control"] })
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "\\", modifiers: ["control"] })
    await wait(600)
  }
  say("panel present", await js(`Boolean(document.querySelector(".panel"))`))

  const reviewTab = await centre(".panel .tab", 0)
  say("review tab at", JSON.stringify(reviewTab))
  say(
    "geometry",
    JSON.stringify({
      focused: window.isFocused(),
      bounds: window.getBounds(),
      content: window.getContentBounds(),
      dpr: await js(`window.devicePixelRatio`),
      inner: await js(`[innerWidth, innerHeight]`),
      zoom: window.webContents.getZoomFactor(),
    }),
  )
  // Is the pointer reaching the page at all, and in which coordinate space?
  await js(`(() => {
    window.__hits = []
    document.addEventListener("mousedown", (e) => window.__hits.push([e.clientX, e.clientY, e.target.className || e.target.tagName]), true)
    return "listening"
  })()`)
  await clickAt(reviewTab[0], reviewTab[1])
  say("what the page saw", await js(`JSON.stringify(window.__hits)`))
  await wait(1500)
  say(
    "tabs after the click",
    await js(`JSON.stringify({
      tabs: [...document.querySelectorAll(".panel .tab")].map((b) => b.textContent.trim() + (b.classList.contains("on") ? "*" : "")),
      scope: (document.querySelector(".scope-btn") || {}).textContent?.trim(),
      rows: document.querySelectorAll(".side-file").length,
      treeRows: document.querySelectorAll(".side-scroll .row").length,
      empty: (document.querySelector(".side-scroll .empty") || {}).textContent?.trim(),
    })`),
  )

  say(
    "the tree",
    await js(`JSON.stringify([...document.querySelectorAll(".side-file")].map((el) => ({
      name: el.querySelector(".side-name").textContent.trim(),
      depth: parseInt(el.style.paddingLeft) || 0,
      folder: Boolean(el.querySelector(".chev")),
      kind: (el.querySelector(".change") || {}).dataset?.kind,
      letter: (el.querySelector(".change") || {}).textContent?.trim(),
      colour: el.querySelector(".change") ? getComputedStyle(el.querySelector(".change")).color : null,
    })))`),
  )

  // ------------------------------------------------------- the focus ring --
  const leafAt = Number(await js(`String([...document.querySelectorAll(".side-file")].findIndex((el) => !el.querySelector(".chev")))`))
  const firstRow = await centre(".side-file", leafAt)
  await clickAt(firstRow[0], firstRow[1])
  say(
    "after a real click",
    await js(`(() => {
      const el = document.querySelector(".side-file.on")
      if (!el) return "nothing selected"
      const s = getComputedStyle(el)
      return JSON.stringify({
        matchesFocusVisible: el.matches(":focus-visible"),
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
        background: s.backgroundColor,
        colour: s.color,
      })
    })()`),
  )

  /*
   * And with the keyboard, where a ring is the whole point. focus() from a
   * script does not settle the question - Chromium decides focus-visible from
   * the device that last acted, so the Tab has to be a real one.
   */
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" })
  window.webContents.sendInputEvent({ type: "char", keyCode: "Tab" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" })
  await wait(400)
  say(
    "after a real Tab",
    await js(`(() => {
      const el = document.activeElement
      if (!el) return "nothing focused"
      const s = getComputedStyle(el)
      return JSON.stringify({
        on: el.className || el.tagName,
        matchesFocusVisible: el.matches(":focus-visible"),
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
      })
    })()`),
  )

  // ------------------------------------------------------------- geometry --
  say(
    "layout",
    await js(`(() => {
      const g = (sel) => { const e = document.querySelector(sel); if (!e) return null
        const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
      return JSON.stringify({
        win: innerWidth,
        panel: g(".panel"), head: g(".head"), side: g(".side"), sideHead: g(".side-head"),
        search: g(".search"), scroll: g(".side-scroll"),
        toolbar: g(".toolbar"), fileHead: g(".file-head"), diff: g(".diff-scroll"),
      })
    })()`),
  )

  say(
    "file header",
    await js(`(() => {
      const q = (s) => (document.querySelector(s) || {}).textContent
      return JSON.stringify({
        status: q(".file-head .status"), kind: (document.querySelector(".file-head .status")||{}).dataset?.kind,
        name: q(".file-name"), dir: q(".file-path"),
        add: q(".file-diff .add"), del: q(".file-diff .del"),
        position: q(".position"),
      })
    })()`),
  )

  say("diff rows", await js(`document.querySelectorAll(".patch-lines .line").length`))
  say(
    "diff fills",
    await js(`JSON.stringify({
      add: getComputedStyle(document.querySelector(".patch-lines .line.add") || document.body).backgroundColor,
      del: getComputedStyle(document.querySelector(".patch-lines .line.del") || document.body).backgroundColor,
    })`),
  )

  await shoot("rv-selected")

  // ------------------------------------------------------- next / previous --
  const next = await centre(".toolbar .nav", 1)
  await clickAt(next[0], next[1])
  say(
    "after next",
    await js(`JSON.stringify({
      position: (document.querySelector(".position")||{}).textContent,
      file: (document.querySelector(".file-name")||{}).textContent,
      selected: (document.querySelector(".side-file.on .side-name")||{}).textContent,
    })`),
  )

  // ---------------------------------------------------------- the sidebar --
  const toggle = await centre(".head-toggle")
  await clickAt(toggle[0], toggle[1])
  await wait(500)
  say(
    "after collapsing",
    await js(`JSON.stringify({
      rootWidth: Math.round(document.querySelector(".side-root").getBoundingClientRect().width),
      diffWidth: Math.round(document.querySelector(".diff-scroll").getBoundingClientRect().width),
      expanded: document.querySelector(".head-toggle").getAttribute("aria-expanded"),
    })`),
  )
  await shoot("rv-collapsed")

  await clickAt(toggle[0], toggle[1])
  await wait(500)

  // Drag the column wider and confirm the diff gives up exactly that much.
  const handle = await centre(".side-resize")
  const before = JSON.parse(await js(`JSON.stringify([
    Math.round(document.querySelector(".side").getBoundingClientRect().width),
    Math.round(document.querySelector(".diff-scroll").getBoundingClientRect().width)])`))
  const hx = toWindow(handle[0])
  const hy = toWindow(handle[1])
  const reach = toWindow(90)
  window.webContents.sendInputEvent({ type: "mouseMove", x: hx, y: hy })
  await wait(60)
  window.webContents.sendInputEvent({ type: "mouseDown", x: hx, y: hy, button: "left", clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: hx + Math.round((reach * step) / 6),
      y: hy,
      button: "left",
      buttons: 1,
    })
    await wait(50)
  }
  window.webContents.sendInputEvent({ type: "mouseUp", x: hx + reach, y: hy, button: "left", clickCount: 1 })
  await wait(400)
  const after = JSON.parse(await js(`JSON.stringify([
    Math.round(document.querySelector(".side").getBoundingClientRect().width),
    Math.round(document.querySelector(".diff-scroll").getBoundingClientRect().width)])`))
  say("resize", JSON.stringify({ before, after }))
  await shoot("rv-wide")

  // ------------------------------------------------------------- filtering --
  await js(`(() => {
    const input = document.querySelector(".search input")
    input.value = "new"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await wait(400)
  say(
    "filtered",
    await js(`JSON.stringify([...document.querySelectorAll(".side-name")].map((n) => n.textContent.trim()))`),
  )

  // ------------------------------------------------- expand / collapse ----
  const clear = async () => {
    await js(`(() => {
      const input = document.querySelector(".search input")
      input.value = ""
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })()`)
    await wait(300)
  }
  await clear()
  /*
   * Widening the context can only show more of a file that has more to show,
   * so this picks the forty-line one rather than whichever sorts first.
   */
  const wideAt = await js(`(() => {
    const rows = [...document.querySelectorAll(".side-file")]
    return String(rows.findIndex((el) => !el.querySelector(".chev") && el.textContent.includes("wide")))
  })()`)
  const anyFile = await centre(".side-file", Number(wideAt))
  await clickAt(anyFile[0], anyFile[1])
  await wait(500)
  say("expanding", await js(`(document.querySelector(".file-name")||{}).textContent`))
  const collapsed = await js(`document.querySelectorAll(".patch-lines .line").length`)
  const expandButton = await centre(".segments .segment:first-child .segment-item", 0)
  await clickAt(expandButton[0], expandButton[1])
  await wait(1200)
  const expanded = await js(`document.querySelectorAll(".patch-lines .line").length`)
  say("expand mode", JSON.stringify({ collapsed, expanded, grew: expanded > collapsed }))

  const collapseButton = await centre(".segments .segment:first-child .segment-item", 1)
  await clickAt(collapseButton[0], collapseButton[1])
  await wait(1000)
  say("back to collapsed", await js(`document.querySelectorAll(".patch-lines .line").length`))

  // ------------------------------------------------------ unified / split --
  const splitButton = await centre(".segments .segment:last-child .segment-item", 1)
  await clickAt(splitButton[0], splitButton[1])
  await wait(600)
  say(
    "split view",
    await js(`JSON.stringify({
      pairs: document.querySelectorAll(".patch-lines.split .pair").length,
      leftNumbers: [...document.querySelectorAll(".pair .side:not(.right) .num")].map((n) => n.textContent).slice(0, 8),
      rightNumbers: [...document.querySelectorAll(".pair .side.right .num")].map((n) => n.textContent).slice(0, 8),
      leftKinds: [...document.querySelectorAll(".pair .side:not(.right)")].map((n) => n.className.replace("side ", "")).slice(0, 8),
      rightKinds: [...document.querySelectorAll(".pair .side.right")].map((n) => n.className.replace("side right ", "")).slice(0, 8),
    })`),
  )
  await shoot("rv-split")

  const unifiedButton = await centre(".segments .segment:last-child .segment-item", 0)
  await clickAt(unifiedButton[0], unifiedButton[1])
  await wait(500)
  say("back to unified", await js(`document.querySelectorAll(".patch-lines .pair").length + " pairs"`))

  // -------------------------------------------------------- arrow stepping --
  const beforeKey = await js(`(document.querySelector(".file-name")||{}).textContent`)
  await js(`document.querySelector(".panel").focus()`)
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" })
  await wait(600)
  const afterKey = await js(`(document.querySelector(".file-name")||{}).textContent`)
  say("arrow key steps", JSON.stringify({ beforeKey, afterKey, moved: beforeKey !== afterKey }))

  // ------------------------------------------------------------- comments --
  say(
    "line numbers offered",
    await js(`JSON.stringify([...document.querySelectorAll(".patch-lines .line")].map((l) => ({
      kind: l.className.replace("line ", ""),
      num: l.querySelector(".num").textContent,
      commentable: Boolean(l.querySelector(".note-add")),
    })).slice(0, 10))`),
  )
  await js(`(() => {
    const line = document.querySelector(".patch-lines .line.add") || document.querySelector(".patch-lines .line.ctx")
    line.querySelector(".note-add").click()
  })()`)
  await wait(400)
  await js(`(() => {
    const field = document.querySelector(".note.editor textarea")
    field.value = "this needs a test"
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  say("cursor in the field", await js(`document.activeElement.tagName`))
  await wait(200)
  await js(`(() => { [...document.querySelectorAll(".note-btn")].find((b) => b.classList.contains("go")).click() })()`)
  await wait(400)
  say(
    "a note",
    await js(`JSON.stringify({
      shown: (document.querySelector(".note.display .note-text")||{}).textContent,
      at: (document.querySelector(".note.display .note-meta")||{}).textContent,
      bar: (document.querySelector(".notes-send")||{}).textContent?.trim(),
    })`),
  )
  await shoot("rv-note")

  say("console errors", errors.length ? JSON.stringify(errors.slice(0, 6)) : "none")
  app.exit(0)
})

// A thrown probe must still say why, and must still let go of the app.
process.on("unhandledRejection", (reason) => {
  try {
    fs.appendFileSync(
      path.join(SCRATCH, "rvprobe.txt"),
      NL + "FAILED: " + (reason && reason.stack ? reason.stack : String(reason)),
    )
  } catch {}
  app.exit(1)
})
