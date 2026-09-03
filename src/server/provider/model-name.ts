/**
 * What a model is called on screen.
 *
 * Discovery asks a provider which models exist and gets back ids: `mimo-v2.5`,
 * `gpt-5.6-sol`. Showing those raw made the picker read like a config file, so
 * a curated name is used when there is one, and an id is cased into something
 * presentable when there is not.
 */

/**
 * Segments whose casing is a brand decision rather than a rule.
 *
 * Keyed by the lowercase segment. Anything absent falls through to sentence
 * case, which is right for the ordinary `pro`, `mini`, `chat` and `preview`.
 */
const SEGMENTS: Record<string, string> = {
  // Vendors and families.
  gpt: "GPT",
  mimo: "MiMo",
  glm: "GLM",
  qwen: "Qwen",
  qwq: "QwQ",
  deepseek: "DeepSeek",
  llama: "Llama",
  minimax: "MiniMax",
  kimi: "Kimi",
  ernie: "ERNIE",
  hunyuan: "Hunyuan",
  doubao: "Doubao",
  yi: "Yi",
  mistral: "Mistral",
  mixtral: "Mixtral",
  codestral: "Codestral",
  nemotron: "Nemotron",
  phi: "Phi",
  gemma: "Gemma",
  nomic: "Nomic",
  bge: "BGE",
  jina: "Jina",
  o1: "o1",
  o3: "o3",
  o4: "o4",
  // Capability suffixes, which are acronyms nearly everywhere.
  tts: "TTS",
  stt: "STT",
  asr: "ASR",
  ocr: "OCR",
  voiceclone: "VoiceClone",
  voicedesign: "VoiceDesign",
  vl: "VL",
  moe: "MoE",
  rl: "RL",
  sft: "SFT",
  hd: "HD",
  api: "API",
  ai: "AI",
  us: "US",
  eu: "EU",
  cn: "CN",
}

/**
 * One dash-separated piece.
 *
 * @param upperV whether a `v1.2` marker becomes `V1.2`. Vendors who name a
 *   model outright write MiMo-V2.5; a hub id like `mistral-7b-instruct-v0.3`
 *   keeps the lowercase v its publisher gave it.
 */
function segment(part: string, upperV = true): string {
  const lower = part.toLowerCase()
  const known = SEGMENTS[lower]
  if (known) return known

  /*
   * A brand with its version glued on - qwen3.8, llama3, glm4. Splitting on
   * separators alone never sees these, so the vendor's own capitalisation was
   * lost on exactly the models a local runtime serves.
   */
  const glued = lower.match(/^([a-z]+)([\d.].*)$/)
  if (glued && SEGMENTS[glued[1]]) return SEGMENTS[glued[1]] + glued[2]

  // A version marker: the v is capitalised, the number is not touched.
  if (/^v\d/.test(lower)) return upperV ? `V${part.slice(1)}` : `v${part.slice(1)}`

  // A parameter count: vendors write 70B, not 70b. Context sizes keep their
  // lowercase k, which is also how they are written.
  if (/^\d+(\.\d+)?b$/.test(lower)) return lower.slice(0, -1) + "B"

  // Pure numbers, dates and version strings stay exactly as they came.
  if (/^[\d.]+$/.test(lower)) return part

  // Already mixed case is a deliberate choice by whoever wrote it.
  if (part !== lower) return part

  return part.charAt(0).toUpperCase() + part.slice(1)
}

/**
 * A display name derived from a model id.
 *
 * Hyphens are kept: they are how these names are written everywhere, and
 * collapsing them to spaces makes `gpt-4o-mini` read as three separate things.
 * A slash is kept too - `qwen/qwen3.8-27b` is a publisher and a model, and both
 * halves need casing, which is what a hyphen-only split missed.
 */
export function nameFromId(id: string): string {
  /*
   * A local runtime appends `:2`, `:3` to tell apart two loads of one model.
   * That is an instance marker rather than part of the name, and the casing
   * rules have to see the name without it - carried along, the final segment
   * matches nothing and keeps whatever casing the id happened to have.
   */
  const instance = id.match(/^(.+)(:\d+)$/)
  if (instance) return nameFromId(instance[1]) + instance[2]

  const parts = id.split("/")
  if (parts.length === 1) return parts[0].split("-").map((piece) => segment(piece)).join("-")

  /*
   * The publisher is left exactly as the runtime reported it.
   *
   * These are account identifiers, not brand names - `mistralai`, `google` and
   * `lmstudio-community` are written in lowercase by the people who own them,
   * and there is no way to tell from the string which ones are a brand. Echoing
   * what the id says is never wrong; inventing a capital can be.
   */
  const [publisher, ...rest] = parts
  const tail = rest.map((part) => part.split("-").map((piece) => segment(piece, false)).join("-"))
  return [publisher, ...tail].join("/")
}
