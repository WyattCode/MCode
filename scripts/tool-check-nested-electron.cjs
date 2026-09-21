/**
 * The nested-shell case of tool-check, run where it can actually fail.
 *
 * A PowerShell started by a command inherits the tool's stdin, and 5.1 reads a
 * redirected stdin to EOF before it exits. From node.exe - a console-subsystem
 * program - every child gets some console however it is spawned, and the
 * nested shell returns in 300ms with or without the fix. Electron's main
 * process is a GUI-subsystem program with no console at all, and there the
 * same command sat for the whole timeout. So this runs under Electron, and
 * writes what it saw to the file named in argv, because a GUI process has no
 * stdout the parent can read.
 */
const { app } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

// `electron helper.cjs a b c` puts the helper at argv[1]; a packaged binary
// would not, so the slice depends on which this is.
const [bundle, out, project] = process.argv.slice(process.defaultApp ? 2 : 1)
app.commandLine.appendSwitch("disable-gpu")
// Whatever happens below, the process must end, or the check hangs forever.
// Long enough for the tool's 8s timeout plus the kill of a hung shell tree,
// which without the fix is what is being measured.
setTimeout(() => app.exit(3), 40000).unref()
app.whenReady().then(async () => {
  const say = (text) => {
    try {
      fs.writeFileSync(out, text + "\n", "utf8")
    } catch {}
  }
  try {
    const { findTool } = await import(pathToFileURL(path.resolve(bundle)).href)
    const bash = findTool("bash")
    const ctx = {
      directory: project,
      signal: new AbortController().signal,
      callID: "c",
      sessionID: "s",
      messageID: "m",
      ask: async () => true,
      progress: () => {},
      permissions: { allowsOutside: () => true, ask: async () => true },
    }
    const started = Date.now()
    try {
      // What actually hung on the user's screen, reduced to its cause. Their
      // command had `Test-Path $_` inside a nested `powershell -Command "..."`;
      // the outer shell expanded `$_` to nothing inside the double quotes, so
      // the inner one received a bare Test-Path, and a cmdlet missing a
      // mandatory parameter prompts for it - on stdin. With stdin an open pipe
      // that prompt waits forever; with no stdin it fails at once. Measured one
      // variable at a time first: Write-Output, Get-Command, a working
      // pipeline, five ways of launching Electron - all ~360ms with or without
      // the fix. Only the prompt reproduces it.
      await bash.execute({ command: 'powershell -NoProfile -Command "Test-Path"', timeout: 8000 }, ctx)
      say("done " + (Date.now() - started))
    } catch (failure) {
      say("failed " + (Date.now() - started) + " " + String(failure.message).split("\n")[0])
    }
  } catch (failure) {
    say("broken " + String(failure && failure.stack ? failure.stack : failure).split("\n").slice(0, 3).join(" | "))
  }
  app.exit(0)
})
