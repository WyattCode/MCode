import { withPatchCheckpoint } from "../src/server/session/patch-checkpoint"

let passed = 0
let failed = 0

function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.error(`failed ${name}`)
  }
}

const MARKER = "Checkpoint: you have identified the fix"

function user(reminders: string[] = []): any {
  return {
    id: "user-1",
    sessionID: "session",
    role: "user",
    text: "fix the failing test",
    attachments: [],
    reminders,
    time: { created: 1 },
  }
}

function assistant(parts: any[], finished = true): any {
  return {
    id: `assistant-${Math.random()}`,
    sessionID: "session",
    role: "assistant",
    parts,
    finish: finished ? "stop" : undefined,
    time: { created: 1, completed: finished ? 2 : undefined },
  }
}

function textPart(text: string): any {
  return { type: "text", text }
}

function readPart(path: string): any {
  return {
    type: "tool",
    id: `read-${Math.random()}`,
    name: "read",
    input: { file_path: path },
    status: "completed",
    output: "file contents",
  }
}

function editPart(): any {
  return {
    type: "tool",
    id: `edit-${Math.random()}`,
    name: "edit",
    input: { file_path: "src/a.py" },
    status: "completed",
    output: "ok",
  }
}

function historyWithSteps(
  steps: number,
  opts: {
    readPath?: string
    lastText?: string
    edit?: boolean
    reminders?: string[]
  } = {},
): any[] {
  const messages: any[] = [user(opts.reminders ?? [])]
  for (let index = 0; index < steps; index++) {
    const parts: any[] = []
    if (index === 0 && opts.readPath) parts.push(readPart(opts.readPath))
    if (opts.edit && index === steps - 1) parts.push(editPart())
    if (index === steps - 1 && opts.lastText) parts.push(textPart(opts.lastText))
    messages.push(assistant(parts))
  }
  return messages
}

function lastUser(history: any[]): any {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.role === "user") return history[index]
  }
  return undefined
}

function hasCheckpoint(history: any[]): boolean {
  const target = lastUser(history)
  return Boolean(target?.reminders?.some((note: string) => note.includes(MARKER)))
}

function main(): void {
  const savedCheckpoint = process.env.MCODE_PATCH_CHECKPOINT
  const savedSteps = process.env.MCODE_PATCH_CHECKPOINT_STEPS
  process.env.MCODE_PATCH_CHECKPOINT_STEPS = "2"
  delete process.env.MCODE_PATCH_CHECKPOINT

  try {
    const firing = historyWithSteps(2, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
    })
    const firingSnapshot = JSON.stringify(firing)
    const fired = withPatchCheckpoint(firing, { local: true })
    check("fires when diagnosis names a read path", fired !== firing && hasCheckpoint(fired))
    check("original history is not mutated", JSON.stringify(firing) === firingSnapshot)

    const notLocal = withPatchCheckpoint(firing, { local: false })
    check("does not fire when not local", notLocal === firing)

    process.env.MCODE_PATCH_CHECKPOINT = "0"
    const envOff = withPatchCheckpoint(firing, { local: true })
    check("does not fire when env disables checkpoint", envOff === firing)
    delete process.env.MCODE_PATCH_CHECKPOINT

    const tooFew = historyWithSteps(1, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
    })
    check("does not fire before threshold", withPatchCheckpoint(tooFew, { local: true }) === tooFew)

    const edited = historyWithSteps(2, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
      edit: true,
    })
    check("does not fire after completed edit", withPatchCheckpoint(edited, { local: true }) === edited)

    const noIntent = historyWithSteps(2, {
      readPath: "src/a.py",
      lastText: "I am still exploring the repository.",
    })
    check("does not fire without fix intent", withPatchCheckpoint(noIntent, { local: true }) === noIntent)

    const wrongPath = historyWithSteps(2, {
      readPath: "src/a.py",
      lastText: "The bug is in src/b.py: should be <=",
    })
    check("does not fire when path was not read", withPatchCheckpoint(wrongPath, { local: true }) === wrongPath)

    const second = historyWithSteps(4, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
      reminders: [MARKER],
    })
    const firedAgain = withPatchCheckpoint(second, { local: true })
    check("fires again at twice the threshold", firedAgain !== second && hasCheckpoint(firedAgain))

    const third = historyWithSteps(6, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
      reminders: [MARKER, MARKER],
    })
    check("does not fire a third time", withPatchCheckpoint(third, { local: true }) === third)

    const between = historyWithSteps(3, {
      readPath: "src/a.py",
      lastText: "The bug is in src/a.py: should be <=",
      reminders: [MARKER],
    })
    check("does not fire second time before twice threshold", withPatchCheckpoint(between, { local: true }) === between)
  } finally {
    if (savedCheckpoint === undefined) delete process.env.MCODE_PATCH_CHECKPOINT
    else process.env.MCODE_PATCH_CHECKPOINT = savedCheckpoint
    if (savedSteps === undefined) delete process.env.MCODE_PATCH_CHECKPOINT_STEPS
    else process.env.MCODE_PATCH_CHECKPOINT_STEPS = savedSteps
  }
}

try {
  main()
} catch (error) {
  console.error(error)
  failed += 1
}

console.log(`${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
