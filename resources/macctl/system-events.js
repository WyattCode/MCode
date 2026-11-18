// JavaScript for Automation, launched by /usr/bin/osascript.
ObjC.import("AppKit")

function matches(app, target) {
  if (!app || !app.processIdentifier) return false
  const id = ObjC.unwrap(app.bundleIdentifier) || ""
  const name = ObjC.unwrap(app.localizedName) || ""
  const filename = ObjC.unwrap(app.bundleURL && app.bundleURL.lastPathComponent) || ""
  const applicationName = target.replace(/\.app$/i, "").toLowerCase()
  return [id, name, filename.replace(/\.app$/i, "")].some((value) => value.toLowerCase() === applicationName)
}

function frontApplication(target) {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication
  if (!matches(app, target)) {
    throw Error("The requested application is not in front")
  }
  return { pid: Number(app.processIdentifier), name: ObjC.unwrap(app.localizedName) || target }
}

function run(argv) {
  const [action, target, ...args] = argv
  if (action === "activate") {
    const workspace = $.NSWorkspace.sharedWorkspace
    if (matches(workspace.frontmostApplication, target)) return
    const running = workspace.runningApplications
    for (let index = 0; index < running.count; index++) {
      const app = running.objectAtIndex(index)
      if (matches(app, target) && app.activateWithOptions(0)) return
    }
    throw Error("The requested application is not in front")
  }
  const front = frontApplication(target)
  if (action === "front") return JSON.stringify(front)
  const events = Application("System Events")
  if (action === "inspect") {
    const process = events.applicationProcesses.whose({ unixId: front.pid })[0]
    const window = process.windows[0]
    if (!window.exists()) return JSON.stringify({ title: front.name, elements: [] })
    const roles = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXLink", "AXComboBox", "AXTab"]
    const elements = []
    for (const element of window.entireContents().slice(0, 250)) {
      try {
        const role = element.role()
        if (!roles.includes(role) || !element.enabled()) continue
        const [x, y] = element.position()
        const [width, height] = element.size()
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
        let label = ""
        try { label = element.name() || "" } catch {}
        try { label ||= element.description() || "" } catch {}
        const title = String(label).slice(0, 160)
        elements.push({ role, title, point: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) } })
      } catch {
        // An AX element can disappear while its window is being read.
      }
    }
    frontApplication(target)
    return JSON.stringify({ title: window.name() || front.name, elements })
  }
  if (action === "type") {
    const [text, clear, submit] = args
    if (clear === "true") events.keystroke("a", { using: ["command down"] })
    frontApplication(target)
    if (text) events.keystroke(text)
    if (submit === "true") {
      frontApplication(target)
      events.keyCode(36)
    }
    return
  }
  if (action === "press") {
    const [kind, key, ...modifiers] = args
    if (kind === "code") events.keyCode(Number(key), { using: modifiers })
    else events.keystroke(key, { using: modifiers })
    return
  }
  throw Error("Unknown desktop operation")
}
