import "./fenced-home"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { closeHidesToTray, type ResponseMap, type UserMessage } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { handle } from "../src/server/handlers"
import type { Runtime } from "../src/server"
import { SessionStore } from "../src/server/session/store"
import { Storage } from "../src/server/storage"
import { archiveNotice, undoArchive } from "../src/renderer/src/lib/archive"
import { language, t } from "../src/renderer/src/lib/i18n"
import { visibleChatOrder } from "../src/renderer/src/lib/visible-chats"

test("the last macOS window hides only with the tray enabled and outside quit", () => {
  const state = { quitting: false, otherWindows: 0, trayEnabled: true }
  assert.equal(closeHidesToTray(state), true)
  assert.equal(closeHidesToTray({ ...state, trayEnabled: false }), false)
  assert.equal(closeHidesToTray({ ...state, quitting: true }), false)
  assert.equal(closeHidesToTray({ ...state, otherWindows: 1 }), false)
  assert.equal(new Config(new Storage("."), new Bus(), "credentials.json").get().tray, false)
})

test("a legacy conversation survives archive, reload and undo, and reappears in the sidebar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcode-tray-archive-"))
  try {
    const storage = new Storage(root)
    const sessions = new SessionStore(storage, new Bus())
    const runtime = { sessions, runner: { abort() {} } } as unknown as Runtime
    const session = await sessions.create({ title: "Keep me", directory: root, model: { provider: "test", model: "test" } })
    const message: UserMessage = {
      id: "msg_archive_test",
      sessionID: session.id,
      role: "user",
      text: "Preserve this transcript",
      attachments: [],
      time: { created: Date.now() },
    }
    await sessions.saveMessage(message)
    const visible = async () => visibleChatOrder(await sessions.list(), [session.id], "recent", (row) => row.title, "en")
    const archive = async (sessionID: string, archived: boolean) =>
      (await handle(runtime, { type: "session.archive", sessionID, archived }) as ResponseMap["session.archive"]).changed

    assert.equal(session.archived, undefined)
    assert.deepEqual(await visible(), [session.id])
    assert.equal(await archive(session.id, true), true)
    assert.deepEqual(await visible(), [])
    const reloaded = new SessionStore(new Storage(root), new Bus())
    const saved = await reloaded.require(session.id)
    assert.equal(saved.title, session.title)
    assert.equal(saved.archived, true)
    assert.ok(saved.archivedAt)
    assert.deepEqual(await reloaded.messages(session.id), [message])
    assert.equal(await archive(session.id, true), false)
    assert.equal((await sessions.require(session.id)).archivedAt, saved.archivedAt)
    assert.equal(await undoArchive([session.id, "missing"], archive), 1)
    assert.deepEqual(await visible(), [session.id])
    assert.equal((await sessions.require(session.id)).archivedAt, undefined)
    assert.deepEqual(await sessions.messages(session.id), [message])
    assert.equal(await undoArchive([session.id], archive), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("archive notices distinguish the action from the number changed", () => {
  language.value = "zh-CN"
  assert.equal(archiveNotice(0, true), "没有可归档的聊天")
  assert.equal(archiveNotice(1, false), "已归档对话")
  assert.equal(archiveNotice(1, true), "已归档 1 个聊天")
  assert.equal(archiveNotice(3, true), "已归档 3 个聊天")
  assert.equal(t("toast.convosRestored", { n: 3 }), "已恢复 3 个对话")
  assert.equal(t("toast.archiveUndoFailed"), "撤销失败，对话已不在已归档中")
})
