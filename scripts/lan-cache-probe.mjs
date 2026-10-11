// Does a request that carries an image lose the server's prefix cache?
//
//   $env:LAN_KEY = "<the key>"      (PowerShell; the script never prints or stores it)
//   node scripts/lan-cache-probe.mjs
//
// Also set LAN_URL (the server's /v1 address); optional LAN_MODEL (default Qwen3.8-Flash-Next).
// Each case sends two requests that share a long prefix and reports, for the second,
// how many prompt tokens the server says it read from cache and how long the first token took.
import zlib from "node:zlib"

const URL_ = (process.env.LAN_URL ?? "").replace(/\/$/, "")
const MODEL = process.env.LAN_MODEL ?? "Qwen3.8-Flash-Next"
const KEY = process.env.LAN_KEY
if (!KEY || !URL_) {
  console.error("Set LAN_KEY and LAN_URL first.")
  process.exit(1)
}

/** A 384x384 random-noise PNG: big enough to cost real image tokens, different every run. */
function png() {
  const w = 384, h = 384
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (Math.random() * 256) | 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
const image = () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png().toString("base64")}` } })

/** ~20k tokens of text nobody has sent before. */
function prefix(tag) {
  const words = []
  for (let i = 0; i < 2600; i++) words.push(`${tag}-${i}-${Math.random().toString(36).slice(2, 8)}`)
  return `Reference notes (${tag}):\n` + words.join(" ")
}

async function ask(messages) {
  const started = Date.now()
  const res = await fetch(`${URL_}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 8,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false, thinking: false },
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  let first
  let usage
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const piece of res.body) {
    buffer += decoder.decode(piece, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue
      const json = JSON.parse(line.slice(5))
      const delta = json.choices?.[0]?.delta
      if (!first && (delta?.content || delta?.reasoning_content || delta?.reasoning)) first = Date.now() - started
      if (json.usage) usage = json.usage
    }
  }
  const prompt = usage?.prompt_tokens
  const cached = usage?.prompt_tokens_details?.cached_tokens
  return { prompt, cached, ttft: first ?? Date.now() - started }
}

const user = (content) => ({ role: "user", content })
const asst = (text) => ({ role: "assistant", content: text })
const show = (name, a, b) =>
  console.log(`${name.padEnd(44)} 2nd request: prompt=${String(b.prompt).padStart(6)} cached=${String(b.cached ?? "n/a").padStart(6)} first-token=${String(b.ttft).padStart(6)}ms   (1st: ${a.ttft}ms)`)

async function pair(name, first, second) {
  const a = await ask(first)
  const b = await ask(second)
  show(name, a, b)
}

console.log(`server ${URL_}  model ${MODEL}\n`)

{
  const p = prefix("A")
  const q1 = [user(`${p}\n\nQuestion 1: say OK.`)]
  await pair("A text only, then one more turn", q1, [...q1, asst("OK"), user("Question 2: say OK again.")])
}
{
  const p = prefix("B"), img = image()
  const q1 = [user([{ type: "text", text: p }, img, { type: "text", text: "Question 1: say OK." }])]
  await pair("B image inside the shared prefix", q1, [...q1, asst("OK"), user("Question 2: say OK again.")])
}
{
  const p = prefix("C")
  const q1 = [user(`${p}\n\nQuestion 1: say OK.`)]
  await pair("C image added only in the new turn", q1, [...q1, asst("OK"), user([{ type: "text", text: "Question 2, with a picture:" }, image()])])
}
{
  const p = prefix("D"), img = image()
  const base = [user(`${p}\n\nQuestion 1: say OK.`), asst("OK"), user([{ type: "text", text: "Here is a picture:" }, img])]
  await pair("D image in history, then text turns", base, [...base, asst("OK"), user("Question 3: say OK again.")])
}
console.log("\nRead it as: cached close to prompt = the server reuses the prefix; cached 0 and a long first-token time = it recomputes everything.")
