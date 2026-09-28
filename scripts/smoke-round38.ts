/**
 * Round 38: the app tool on Android, through adb.
 *
 * What needs no device - reading uiautomator's XML, naming, keys and text for
 * adb - is checked every time. What needs one runs when adb sees a device
 * (an emulator counts), against the system Settings app, which every Android
 * has; otherwise that section says it was skipped.
 *
 * smoke.ts calls `roundThirtyEightChecks` with its own check and section.
 */
import os from "node:os"
import { execFile } from "node:child_process"
import type { Check } from "./smoke-round5"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { adbText, androidKey, findAdb, listDevices, parseHierarchy } from "../src/server/appdrive/android"
import { AGENT_DEX } from "../src/server/appdrive/android-agent"
import type { ToolContext } from "../src/server/tool/types"

function contextFor(sessionID: string, asked: string[]): ToolContext {
  return {
    sessionID,
    messageID: "msg",
    callID: "call",
    directory: os.tmpdir(),
    permissions: { ask: async (request: { subject: string }) => void asked.push(request.subject) } as unknown as ToolContext["permissions"],
    questions: {} as ToolContext["questions"],
    signal: new AbortController().signal,
    progress: () => undefined,
    snapshot: async () => undefined,
  }
}

const SETTINGS_ROW = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1440,2560]"><node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,300][1440,500]"><node index="0" text="Airplane &amp; &quot;mode&quot;" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,340][900,420]"/><node index="1" text="" resource-id="android:id/widget_frame" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1200,340][1400,460]"><node index="0" text="" resource-id="android:id/switchWidget" class="android.widget.Switch" package="com.android.settings" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[1220,360][1380,440]"/></node></node><node index="1" text="Network &amp; internet" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,100][900,200]"/></node></hierarchy>`

export async function roundThirtyEightChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 38: reading an Android screen and speaking adb, without a device")
  {
    const roots = parseHierarchy(SETTINGS_ROW)
    const row = roots[0]?.children[0]
    check("uiautomator's XML is read into nodes, entities decoded", row?.children[0]?.attrs.text === 'Airplane & "mode"' && row?.children[1]?.children[0]?.attrs.class === "android.widget.Switch")
    check("each node keeps its place in the tree, which is how it keeps its number", row?.children[1]?.children[0]?.path === "/0/0/1/0")
    check("text for adb: spaces as %s, and the shell's own characters escaped", adbText("hello world & $HOME") === "hello%sworld%s\\&%s\\$HOME")
    check("keys for adb: named keys, letters and digits", androidKey("Enter").join() === "66" && androidKey("Back").join() === "4" && androidKey("a").join() === "29" && androidKey("7").join() === "14")
    let refused = ""
    try {
      androidKey("Control+a")
    } catch (error) {
      refused = (error as Error).message
    }
    check("a combination is refused, saying why", /cannot be sent to Android/.test(refused), refused)
    const dex = Buffer.from(AGENT_DEX, "base64")
    check("the screen reader that runs on the device ships as a .dex, built from its source", dex.subarray(0, 4).toString("latin1") === "dex\n" && dex.length > 2_000)
  }

  section("Round 38: the app tool driving the Settings app on an Android device")
  {
    const adb = findAdb()
    const devices = adb ? (await listDevices(adb).catch(() => [])).filter((device) => device.state === "device") : []
    if (!adb || devices.length !== 1) {
      check(`(skipped: ${!adb ? "no adb on this machine" : devices.length ? "more than one device connected" : "no Android device connected"})`, true)
      return
    }
    const asked: string[] = []
    const context = contextFor("r38-android", asked)
    const run = (input: Record<string, unknown>) => AppTool.execute(input, context)
    try {
      const started = Date.now()
      const opened = await run({ action: "android", package: "com.android.settings" })
      check("android starts the app, asks once naming it, and lists its screen", asked.length === 1 && /com\.android\.settings/.test(asked[0]!) && /android:\/\/com\.android\.settings/.test(opened.output) && /^\[\d+\] \w+ "/m.test(opened.output), { asked, output: opened.output.slice(0, 600) })
      check("and is ready within ten seconds", Date.now() - started < 10_000, Date.now() - started)
      const first = Number(opened.output.split("\n").find((line) => /^\[\d+\] clickable "/.test(line))?.match(/^\[(\d+)\]/)?.[1])
      const clickedAt = Date.now()
      const moved = await run({ action: "do", steps: [{ action: "click", ref: first }, { action: "back" }] })
      const took = Date.now() - clickedAt
      check("a tap and a back each report what they did", /^1\. click \[\d+\] -> (shows|\d+ element)/.test(moved.output) && /\n2\. back -> (shows|\d+ element)/.test(moved.output), moved.output)
      check("and take seconds, not tens of seconds - the reader stays running on the device", took < 5_000, { took })
      const listing = await run({ action: "snapshot", full: true })
      check("a switch is named by its row, not by its id", !/switch "switchWidget"/.test(listing.output), listing.output.slice(0, 800))
      const evaluated = await run({ action: "eval", expression: "1" }).then(() => "", (error: Error) => error.message)
      check("eval says it is not for Android", /on Android, read the screen/.test(evaluated), evaluated)
      const shot = await run({ action: "screenshot" })
      check("a screenshot comes from the device", /Saved the window as/.test(shot.output))
      await run({ action: "close" })
      const after = await new Promise<string>((resolve) =>
        execFile(adb, ["-s", devices[0]!.serial, "shell", "dumpsys", "activity", "activities"], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_: unknown, out: string) => resolve(String(out))),
      )
      check("close stops the app it started", !/mResumedActivity.*com\.android\.settings/.test(after))
    } finally {
      await closeAllApps()
    }
  }
}
