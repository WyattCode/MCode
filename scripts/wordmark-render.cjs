/**
 * Renders the wordmark's letters for scripts/wordmark.mjs, which starts this
 * with Electron: "Code" and a lone "C" in Montserrat Bold (the face ships
 * beside it in scripts/fonts, under the SIL Open Font License), white on
 * black, as greyscale masks the caller inks. Chromium draws the face from the
 * file itself, so the result is the same on any machine.
 *
 * Refuses to write if the face did not load: a mask in a fallback face would
 * be the wrong wordmark rather than a slightly different one.
 *
 * Arguments: the folder to write word.png and cap.png into.
 */
const path = require("node:path")
const fs = require("node:fs")
const { app, BrowserWindow } = require("electron")

const OUT = process.argv[process.argv.length - 1]
const FONT = path.join(__dirname, "fonts", "montserrat-latin-700-normal.woff2").replace(/\\/g, "/")
const SIZE = 440

app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("force-device-scale-factor", "1")

app.whenReady().then(async () => {
  let failed = ""
  try {
    const window = new BrowserWindow({ width: 2400, height: 700, show: false, webPreferences: { offscreen: true } })
    for (const [name, text] of [
      ["word", "Code"],
      ["cap", "C"],
    ]) {
      const page = path.join(OUT, "wordmark-page.html")
      fs.writeFileSync(
        page,
        `<!doctype html><html><head><style>
          @font-face { font-family: Wordmark; src: url("file:///${FONT}") format("woff2"); font-weight: 700; }
          html, body { margin: 0; background: #000; }
          span { position: absolute; left: 100px; top: 60px; font: 700 ${SIZE}px/1 Wordmark; color: #fff; }
        </style></head><body><span>${text}</span></body></html>`,
      )
      await window.loadFile(page)
      const loaded = await window.webContents.executeJavaScript(`document.fonts.load("700 ${SIZE}px Wordmark").then((faces) => faces.length > 0, () => false)`)
      if (!loaded) throw new Error(`Montserrat did not load from ${FONT}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
      fs.writeFileSync(path.join(OUT, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    }
  } catch (error) {
    failed = String((error && error.message) || error)
  }
  if (failed) fs.writeFileSync(path.join(OUT, "error.txt"), failed)
  app.exit(failed ? 1 : 0)
})
