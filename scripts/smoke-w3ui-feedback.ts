import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { between, component, dialog, mount } from "./smoke-ui-races"
import type { Request } from "../src/shared/protocol"
import { handle } from "../src/server/handlers"
import { Storage } from "../src/server/storage"

type Check = (label: string, ok: boolean, detail?: unknown) => void

export async function w3uiFeedbackChecks(check: Check): Promise<void> {
  for (const [label, run] of [
    ["composer names its input in chat, plan and shell", composerName],
    ["reply toggles and feedback dialog save only on confirmation", replyFeedback],
    ["feedback handler appends and reads real local records", feedbackDisk],
    ["feedback settings list and export local records", feedbackSettings],
  ] as const) {
    try { await run(); check(label, true) } catch (err) { check(label, false, (err as Error).message) }
  }
}

async function composerName() {
  const textarea = component("Composer").match(/<textarea\s+ref="input"[\s\S]*?\/>/)![0]
  for (const mode of ["chat", "plan", "shell"]) {
    const ui = await mount(`
      const mode = fixture.mode, text = ref(""), placeholder = "placeholder"
      const runningChat = false, compactingHere = false, restrictedHere = false
      const onKeydown = () => {}, onInputBlur = onKeydown, syncCaret = onKeydown
      const onBoxClick = onKeydown, onPaste = onKeydown
    `, textarea, { mode })
    try { assert.equal(ui.get("textarea").getAttribute("aria-label"), mode === "shell" ? "composer.shellMode" : "composer.messageInput") } finally { ui.close() }
  }
}

async function replyFeedback() {
  const source = component("MessageStream")
  const writes: unknown[] = []
  const notices: string[] = []
  const ui = await mount(`
    import FeedbackDialog from "fixture:feedback"
    const shownID = ref("session"), bare = ref(false), turn = { last: { id: "reply" } }
    const app = { client: { request: fixture.request } }
    ${between(source, "// Reply feedback", "async function branchReply")}
  `, between(source, "<!-- Reply feedback controls -->", "<!-- 追求目标: the one word"), {
    simulateFocus: true,
    notify: (label: string) => notices.push(label),
    request: async (request: { type: string }) => {
      if (request.type === "feedback.list") return { records: [] }
      writes.push(request)
    },
  }, { feedback: dialog("FeedbackDialog", 'const FEEDBACK_TYPES = ["incorrect", "incomplete", "other"]') }, true)
  try {
    await ui.settle()
    const like = ui.get('[data-msg-act="like"]')
    const dislike = ui.get('[data-msg-act="dislike"]')
    assert.equal(like.getAttribute("aria-pressed"), "false")
    assert.equal(ui.event(like, "keydown", { key: " " }).defaultPrevented, false)
    like.click()
    await ui.settle()
    assert.equal(like.getAttribute("aria-pressed"), "true")
    like.click()
    await ui.settle()
    assert.equal(like.getAttribute("aria-pressed"), "false")
    like.click()
    await ui.settle()
    dislike.focus()
    dislike.click()
    await ui.settle()
    assert.equal(ui.get("[data-feedback-dialog]").getAttribute("role"), "dialog")
    assert.equal(ui.get<HTMLInputElement>("[data-feedback-attach]").checked, false)
    ui.get("[data-feedback-cancel]").click()
    await ui.settle()
    assert.equal(writes.length, 3)
    assert.equal(ui.document.activeElement, dislike)
    dislike.click()
    await ui.settle()
    for (const selector of ['[data-feedback-type="incorrect"]', '[data-feedback-type="incomplete"]', "[data-feedback-attach]"]) {
      const checkbox = ui.get<HTMLInputElement>(selector)
      checkbox.click()
      // Domino omits native checkbox activation and its change event.
      checkbox.checked = true
      ui.event(checkbox, "change")
      await ui.settle()
    }
    ui.input("textarea", "line one\nline two")
    ui.get("[data-feedback-submit]").click()
    // Domino does not perform a submit button's native form action.
    if (writes.length === 3) ui.event(ui.get("[data-feedback-dialog]"), "submit")
    await ui.settle()
    assert.deepEqual(writes.at(-1), {
      type: "feedback.record", sessionID: "session", messageID: "reply",
      rating: "dislike", types: ["incorrect", "incomplete"], description: "line one\nline two", includeMaterials: true,
    })
    assert.equal(like.getAttribute("aria-pressed"), "false")
    assert.equal(dislike.getAttribute("aria-pressed"), "true")
    assert.equal(notices.at(-1), "feedback.saved")
    dislike.click()
    await ui.settle()
    assert.equal(dislike.getAttribute("aria-pressed"), "false")
  } finally { ui.close() }
}

async function feedbackDisk() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "w3ui-feedback-"))
  try {
    const storage = new Storage(directory)
    const messages = [{ id: "reply", role: "assistant", parts: [] }]
    const runtime = { storage, sessions: { messages: async () => messages } } as unknown as Parameters<typeof handle>[0]
    const request = (value: object) => handle(runtime, value as Request)
    const base = { type: "feedback.record", sessionID: "session", messageID: "reply", types: [], description: "", includeMaterials: false }
    await Promise.all([
      request({ ...base, rating: "like" }),
      request({ ...base, rating: "dislike", types: ["incorrect"], description: "test\nfeedback", includeMaterials: true }),
    ])
    await request({ ...base, rating: null })
    await assert.rejects(request({ ...base, rating: "invalid" }))
    await assert.rejects(request({ ...base, messageID: "missing", rating: "like" }))
    await assert.rejects(handle(runtime, { type: "feedback.list", exportAll: true }, { remote: true }))
    const keys = await storage.list("feedback")
    assert.equal(keys.length, 3)
    const records = await Promise.all(keys.map((key) => new Storage(directory).read<Record<string, unknown>>(`feedback/${key}`)))
    assert.equal(records.find((record) => record?.rating === "like")?.materials, undefined)
    assert.deepEqual(records.find((record) => record?.rating === "dislike"), {
      at: records.find((record) => record?.rating === "dislike")?.at,
      sessionID: "session", messageID: "reply", rating: "dislike", types: ["incorrect"],
      description: "test\nfeedback", includeMaterials: true, materials: messages,
    })
    const listed = await request({ type: "feedback.list", sessionID: "session" }) as { records: Record<string, unknown>[] }
    assert.equal(listed.records[0].rating, null)
    assert(Number.isFinite(listed.records[0].at))
    assert(listed.records.every((record) => !("materials" in record)))
    const exported = await request({ type: "feedback.list", exportAll: true }) as typeof listed
    assert.deepEqual(exported.records.find((record) => record.rating === "dislike")?.materials, messages)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function feedbackSettings() {
  const source = component("SettingsDialog")
  const record = { at: 1, sessionID: "session", messageID: "reply", rating: "like", types: [], description: "test entry" }
  const exports: unknown[][] = []
  const ui = await mount(`
    const section = ref("feedback"), language = "en"
    const isPickerBusy = () => false
    const app = { client: { request: fixture.request } }
    window.mcode = { saveText: fixture.saveText }
    ${between(source, "// Local feedback history", "const emit =")}
  `, between(source, '<template v-else-if="section === \'feedback\'">', '<div v-else-if="section === \'keys\'"').replace("v-else-if", "v-if"), {
    request: async () => ({ records: [record] }),
    saveText: async (...args: unknown[]) => { exports.push(args); return "/tmp/mcode-feedback.json" },
  })
  try {
    await ui.settle()
    assert.match(ui.get("[data-feedback-history]").textContent ?? "", /test entry/)
    ui.get("[data-feedback-export]").click()
    await ui.settle()
    assert.deepEqual(JSON.parse(String(exports[0][1])), [record])
  } finally { ui.close() }
}
