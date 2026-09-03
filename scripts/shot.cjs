/**
 * Boots the packaged app under Electron, drives it through its main screens,
 * and captures a screenshot of each. A clean process exit does not prove the UI
 * painted, so this also probes the DOM and reports console errors.
 *
 * Run with: npx electron scripts/shot.cjs
 */
const path = require("node:path")
const fs = require("node:fs")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow } = require("electron")

const OUT = path.join(__dirname, "..", "out", "shot")
const errors = []

app.commandLine.appendSwitch("disable-gpu")

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  // Reuse the real main process so backend, preload, and IPC boot as they do
  // in production.
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

  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message)
  })
  window.webContents.on("preload-error", (_event, file, error) => {
    errors.push(`preload ${file}: ${error.message}`)
  })

  await wait(3500)

  const js = (code) => window.webContents.executeJavaScript(code)

  const shoot = async (name) => {
    await wait(500)
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG())
    console.log(`captured ${name}.png`)
  }

  const press = (key, options = {}) =>
    window.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({
        key,
        ctrlKey: true,
        bubbles: true,
        ...options,
      })}))`,
    )

  // Drive the theme through the app's own setting - App.vue owns the
  // data-theme attribute now, so writing it directly here would be overwritten.
  const setTheme = async (theme) => {
    await window.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown",{key:",",ctrlKey:true,bubbles:true}))`,
    )
    await wait(500)
    await window.webContents.executeJavaScript(`(() => {
      const s=[...document.querySelectorAll("select")].find(s=>[...s.options].some(o=>o.value==="system"));
      if(!s) return;
      s.value=${JSON.stringify(theme)};
      s.dispatchEvent(new Event("change",{bubbles:true}));
    })()`)
    await wait(400)
    await window.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`,
    )
    await wait(500)
  }

  await setTheme("dark")
  await shoot("home-dark")

  await setTheme("light")
  await shoot("home-light")

  await setTheme("dark")

  // Ctrl+N creates a session in the default directory, which moves the app
  // from the launcher into a workspace.
  await press("n")
  await wait(1200)
  await shoot("session-dark")

  // Docked project panel (the sidebar column).
  await press("b")
  await wait(700)
  await shoot("sidebar-docked")
  await press("b")
  await wait(400)

  // Open the project panel from its rail badge.
  await window.webContents.executeJavaScript(`
    (() => { const b = document.querySelector("nav .badge"); if (b) b.click(); })()
  `)
  await wait(700)
  await shoot("project-panel")

  await window.webContents.executeJavaScript(`document.body.click()`)
  await wait(300)

  await press(",")
  await wait(600)
  await shoot("settings-dark")

  // Providers page inside Settings.
  await js(`(() => {
    const b=[...document.querySelectorAll(".nav-item")].find(n=>n.textContent.trim().length);
    const items=[...document.querySelectorAll(".nav-item")];
    if(items[3]) items[3].click();
  })()`)
  await wait(700)
  await shoot("settings-providers")

  await js(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`)
  await wait(500)

  // Model pill menu in the composer.
  await js(`(() => {
    const pills=[...document.querySelectorAll(".pill")];
    if(pills[1]) pills[1].click();
  })()`)
  await wait(700)
  await shoot("composer-model-menu")

  const probe = await window.webContents.executeJavaScript(`
    JSON.stringify({
      title: document.title,
      mounted: Boolean(document.querySelector(".app")),
      rail: Boolean(document.querySelector("nav")),
      composer: Boolean(document.querySelector("textarea")),
      filePanel: Boolean(document.querySelector("aside")),
      bodyText: document.body.innerText.replace(/\\s+/g, " ").slice(0, 260),
    })
  `)
  console.log("probe:", probe)
  console.log("console errors:", errors.length ? errors : "none")

  app.exit(errors.length ? 1 : 0)
})
