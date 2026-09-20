/**
 * Round 15 (lane U2) measured rather than read: the settings dialog's own
 * stylesheet, laid out by Chromium.
 *
 * The CSS is lifted straight out of `SettingsDialog.vue`'s `<style scoped>` -
 * the scope attribute is what the compiler adds later, so the selectors in the
 * source text match plain markup as they are - and dropped onto a page holding
 * the two rows that break at the window's 720px minimum, in a card as wide as
 * the card measured there. What comes back is geometry and computed values, so
 * a check can say "the label is drawn over the buttons" and "this path is
 * 11.5px" about the real cascade instead of about the source text.
 *
 * Bundled to a .cjs and started as Electron's main script by
 * smoke-round15-ui-settings.ts, which passes the .vue file and the file to
 * write. A GUI process has no stdout the parent can read, so the readings go
 * out as JSON.
 */
import { app, BrowserWindow } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const [source, out] = process.argv.slice(process.defaultApp ? 2 : 1)
app.commandLine.appendSwitch("disable-gpu")
// Whatever happens below, the process must end.
setTimeout(() => app.exit(3), 60_000).unref()

/** The card the models and MCP pages draw at the 720px minimum, measured in the window. */
const CARD = 330

/** The `<style scoped>` block, with `:deep(x)` flattened to `x` - the compiler's own reading of it. */
function stylesheet(vue: string): string {
  const at = vue.indexOf("<style scoped>")
  const end = vue.indexOf("</style>", at)
  return vue.slice(at + "<style scoped>".length, end).replace(/::?v-deep\(([^)]*)\)|:deep\(([^)]*)\)/g, (_all, a, b) => a ?? b)
}

/*
 * German, because it is the language the overlap was found in: a provider row
 * with the "custom" tag and three buttons, and an MCP row whose name is one
 * long word. The wrappers stand in for what the page puts around them - a
 * fixed-width card, and a 24px provider mark.
 */
const BODY = `
<div id="page">
  <div class="card" id="pcard">
    <div class="prow" id="prow">
      <span class="pmark" style="flex: none; width: 24px; height: 24px"></span>
      <div class="ptext">
        <div class="pname" id="pname">R15 Probe<span class="tag" id="ptag">Benutzerdefiniert</span></div>
        <div class="pdesc">1 Modelle</div>
      </div>
      <span class="ctl-pair" id="ppair">
        <button class="ctl-btn">Bearbeiten</button>
        <button class="ctl-btn">Kopieren</button>
        <button class="ctl-btn">Entfernen</button>
      </span>
    </div>
  </div>
  <div class="card" id="mcard">
    <div class="line" id="mrow">
      <div class="line-text">
        <div class="line-title" id="mtitle">ein-sehr-langer-server-name-fuer-den-test</div>
        <div class="line-sub mcp-row-desc"><span>Remote &middot; http</span></div>
      </div>
      <div class="mcp-ctrl" id="mctrl">
        <button class="switch"><span class="knob"></span></button>
        <button class="ctl-btn">Tools</button>
        <button class="ctl-btn">Bearbeiten</button>
        <button class="ctl-btn">Entfernen</button>
      </div>
    </div>
  </div>
  <div class="card" id="scard">
    <div class="line" id="srow">
      <div class="line-text">
        <div class="line-title" id="stitle">ein-sehr-langer-server-name-fuer-den-test</div>
        <div class="line-sub mcp-row-desc"><span>&#36828;&#31243;</span></div>
      </div>
      <div class="mcp-ctrl" id="sctrl">
        <button class="switch"><span class="knob"></span></button>
        <button class="ctl-btn">&#24037;&#20855;</button>
        <button class="ctl-btn">&#32534;&#36753;</button>
        <button class="ctl-btn">&#31227;&#38500;</button>
      </div>
    </div>
  </div>
  <div class="card empty-card" id="ecard"><div class="empty-title">a</div></div>
  <div class="card wt-empty" id="wcard"><div class="wt-empty-title">a</div></div>
  <div class="line-sub config-path" id="cpath">/tmp/mcode.json</div>
  <div class="line-sub path" id="spath">/tmp/proj</div>
  <div class="line-sub" id="plainsub">plain</div>
</div>`

/** Geometry and computed values, read in the page. */
const READ = `(function () {
  const byId = (id) => document.getElementById(id)
  const rect = (id) => { const r = byId(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } }
  const cover = (p, q) => {
    const x = Math.min(p.right, q.right) - Math.max(p.left, q.left)
    const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top)
    return x > 0.5 && y > 0.5 ? Math.round(Math.min(x, y)) : 0
  }
  // How far two boxes actually cover one another, on both axes at once.
  const overlap = (a, b) => cover(byId(a).getBoundingClientRect(), byId(b).getBoundingClientRect())
  /*
   * The same, but for where the letters land rather than where the box is: a
   * word too long to break sticks out of its own box, so the box can sit clear
   * of the control while the text is drawn across it.
   */
  const inkOver = (a, b) => {
    const q = byId(b).getBoundingClientRect()
    let worst = 0
    for (const node of byId(a).childNodes) {
      if (node.nodeType !== 3) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const line of range.getClientRects()) worst = Math.max(worst, cover(line, q))
    }
    return worst
  }
  // How far the control group runs past the card's padding box, where the card's overflow: hidden cuts it off.
  const past = (cardId, groupId) => {
    const card = byId(cardId), style = getComputedStyle(card)
    const inner = card.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
    return Math.round(byId(groupId).getBoundingClientRect().right - inner)
  }
  const clipped = (cardId) => Math.round(byId(cardId).scrollWidth - byId(cardId).clientWidth)
  const font = (id) => getComputedStyle(byId(id)).fontSize
  return {
    cardWidth: Math.round(byId("pcard").getBoundingClientRect().width),
    provider: {
      tagOverButtons: overlap("ptag", "ppair"),
      nameOverButtons: inkOver("pname", "ppair"),
      buttonsPastCard: past("pcard", "ppair"),
      cardClipsX: clipped("pcard"),
      rowHeight: Math.round(rect("prow").h),
    },
    mcp: {
      titleOverControl: inkOver("mtitle", "mctrl"),
      controlPastCard: past("mcard", "mctrl"),
      cardClipsX: clipped("mcard"),
      titleHeight: Math.round(rect("mtitle").h),
      titleLines: Math.round(rect("mtitle").h / parseFloat(getComputedStyle(byId("mtitle")).lineHeight)),
    },
    // The same row with the short buttons a Chinese window draws: they fit
    // beside the name, so nothing makes them move unless the name asks first.
    shortButtons: {
      titleOverControl: inkOver("stitle", "sctrl"),
      controlPastCard: past("scard", "sctrl"),
      cardClipsX: clipped("scard"),
      titleLines: Math.round(rect("stitle").h / parseFloat(getComputedStyle(byId("stitle")).lineHeight)),
    },
    padding: {
      emptyCard: getComputedStyle(byId("ecard")).padding,
      wtEmpty: getComputedStyle(byId("wcard")).padding,
    },
    fontSize: { configPath: font("cpath"), subPath: font("spath"), lineSub: font("plainsub") },
  }
})()`

app.whenReady().then(async () => {
  const write = (value: unknown) => fs.writeFileSync(out, JSON.stringify(value), "utf8")
  try {
    const css = stylesheet(fs.readFileSync(source, "utf8"))
    const page = `<!doctype html><meta charset="utf-8"><style>
      html, body { margin: 0; font-family: system-ui, "Segoe UI", sans-serif }
      #page { width: ${CARD}px }
      ${css}
    </style>${BODY}`
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r15u2-")), "page.html")
    fs.writeFileSync(file, page, "utf8")
    const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false } })
    await window.loadFile(file)
    write(await window.webContents.executeJavaScript(READ))
  } catch (error) {
    write({ error: String(error).slice(0, 300) })
  }
  app.exit(0)
})
