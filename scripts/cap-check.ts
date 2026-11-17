import "./fenced-home"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { BashTool } from "../src/server/tool/bash"
import { ReadTool } from "../src/server/tool/read"
import { GlobTool, GrepTool } from "../src/server/tool/search"
import { ToolOutputs } from "../src/server/tool/truncate"
import type { ToolContext } from "../src/server/tool/types"
process.env.MCODE_BASH_RAW = "1"
const root = await fs.mkdtemp(path.resolve("tmp-local/cap-"))
const context = {
  directory: root, sessionID: "cap", messageID: "cap", callID: "cap",
  signal: new AbortController().signal, progress() {}, snapshot: async () => {},
  permissions: { ask: async () => {}, waive() {}, allowsOutside: () => true },
  toolOutputs: new ToolOutputs(path.join(root, "outputs")),
} as unknown as ToolContext
let failed = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`ok ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error}`) }
}
const command = (text: string) => `${JSON.stringify(process.execPath)} -e 'process.stdout.write(${JSON.stringify(text)})'`
const fat = "0123456789abcdef".repeat(3750) // 60,000 bytes, ~15K four-byte tokens
const bash = (text: string, extra = {}) => BashTool.execute({ command: command(text), ...extra }, context)
await test("bash default cap and full output", async () => {
  const result = await bash(fat)
  assert.ok(Buffer.byteLength(result.output) <= 25_000)
  assert.match(result.output, /whole output is saved at/)
  assert.equal(await fs.readFile(String(result.metadata?.outputPath), "utf8"), fat)
  assert.equal((await bash(fat, { max_output_tokens: 30_000 })).output, fat)
})
await fs.writeFile(path.join(root, "large.txt"), Array.from({ length: 1000 }, (_, i) => `${i} ${"x".repeat(100)}`).join("\n"))
await test("read cap and offset continuation", async () => {
  const result = await ReadTool.execute({ file_path: "large.txt" }, context)
  assert.ok(result.output.length <= 25_000)
  const next = /offset=(\d+)/.exec(result.output)
  assert.ok(next)
  const continued = await ReadTool.execute({ file_path: "large.txt", offset: Number(next[1]) }, context)
  assert.match(continued.output, new RegExp(`\\n${next[1]}:`))
})
const files = path.join(root, "files")
await fs.mkdir(files)
await Promise.all(Array.from({ length: 250 }, (_, i) => fs.writeFile(path.join(files, `${i}.txt`), "needle\n")))
await test("glob count cap and narrowing marker", async () => {
  const result = await GlobTool.execute({ pattern: "*.txt", path: files }, context)
  assert.ok(result.output.split("\n").filter(line => line.startsWith(files)).length <= 100)
  assert.match(result.output, /250/)
  assert.match(result.output, /Narrow|缩小/)
})
await test("grep count cap and narrowing marker", async () => {
  const result = await GrepTool.execute({ pattern: "needle", path: files }, context)
  assert.equal(result.output.split("\n").filter(line => /^  Line /.test(line)).length, 100)
  assert.match(result.output, /250/)
  assert.match(result.output, /Narrow|缩小/)
})
await test("fat transcript >=50% smaller; short transcript byte identical", async () => {
  const format = (outputs: string[]) => JSON.stringify(outputs.map(output => ({ role: "tool", content: output })))
  const before: string[] = [], after: string[] = []
  for (let i = 0; i < 5; i++) {
    before.push((await bash(fat, { max_output_tokens: 30_000 })).output)
    after.push((await bash(fat)).output)
  }
  const oldBytes = Buffer.byteLength(format(before)), newBytes = Buffer.byteLength(format(after))
  console.log(`fixture fat before=${oldBytes} after=${newBytes} reduction=${((1 - newBytes / oldBytes) * 100).toFixed(2)}%`)
  assert.ok(newBytes <= oldBytes * 0.5)
  const short = "build passed\n"
  const oldShort = format([(await bash(short, { max_output_tokens: 30_000 })).output])
  const newShort = format([(await bash(short)).output])
  assert.equal(newShort, oldShort)
  console.log(`fixture short before=${Buffer.byteLength(oldShort)} after=${Buffer.byteLength(newShort)}`)
})
await fs.rm(root, { recursive: true, force: true })
if (failed) process.exitCode = 1
