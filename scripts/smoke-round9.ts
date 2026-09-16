/**
 * Round 9: every model family MiMo's engine tells apart reads a prompt of its
 * own, chosen by the engine's own rule.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundNineChecks` with its own check and section. The expected family of
 * each id and the heading each prompt is organised around are written out
 * here by hand, so a changed rule or a lost section fails instead of agreeing
 * with itself - and a prompt a family "gets" only counts once the provider
 * has been sent it.
 */
import type { Check } from "./smoke-round5"
import { engine, say } from "./smoke-round5"
import { FAMILY_PROMPTS, promptFamily, type PromptFamily } from "../src/server/session/prompts"

/** The system text of a request, as the chat-completions wire carries it. */
function systemOf(body: Record<string, any> | undefined): string {
  const first = body?.messages?.[0]
  return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "")
}

/*
 * Representative ids, and what MiMo's engine picks for each. The awkward ones
 * are the point: the rule is substring matching in a fixed order, with some
 * tests case-sensitive and some not, and the provider plays no part.
 */
const EXPECTED: [string, PromptFamily][] = [
  ["claude-sonnet-5", "anthropic"],
  ["anthropic/claude-haiku-4-5", "anthropic"],
  ["gpt-5.1", "gpt"],
  ["openai/gpt-4o", "gpt"],
  ["GPT-5-Codex", "gpt"],
  ["o3-mini", "beast"],
  ["o1", "beast"],
  ["gemini-3-pro", "gemini"],
  ["google/gemini-2.5-flash", "gemini"],
  ["kimi-k2.5", "kimi"],
  ["moonshotai/Kimi-K2-Instruct", "kimi"],
  ["deepseek-v3.2", "deepseek"],
  ["DeepSeek-R1", "deepseek"],
  ["glm-4.6", "glm"],
  ["zai-org/GLM-4.5-Air", "glm"],
  ["MiniMax-M2", "minimax"],
  ["minimax-m2.1", "minimax"],
  ["arcee-ai/trinity-large", "trinity"],
  ["qwen3-coder-30b", "general"],
  ["qwen38-nvfp4", "general"],
  ["mimo-v2.5-pro", "general"],
]

/* Ids a looser rule would put in the wrong family. */
const TRAPS: [string, PromptFamily, string][] = [
  ["gpt-oss-120b", "general", "gpt-oss is not the GPT line"],
  ["openai/gpt-oss-20b", "general", "not even under the openai namespace"],
  ["codex-mini", "general", "an id that does not say gpt is not GPT"],
  ["Claude-3-Opus", "general", "claude is matched in lower case only"],
  ["gemini2", "general", "gemini needs its hyphen"],
  ["Gemini-2.5-Pro", "general", "and its lower case"],
  ["moonshot-v1-8k", "general", "a Moonshot model that does not say kimi"],
  ["gpt-4-turbo", "gpt", "gpt-4 is GPT before it is o-series"],
  ["deepseek-o1-distill", "beast", "o1 is tested before deepseek"],
  ["kimi-gemini-", "gemini", "gemini is tested before kimi"],
]

/* The heading, or opening, each prompt is organised around - written out, not read off the prompt. */
const MARK: Record<PromptFamily, string[]> = {
  anthropic: ["\n# Harness\n", "\n# Corrections\n"],
  gpt: ["\n# Personality\n", "\n## Final answer\n"],
  beast: ["\n# Workflow\n", "\n## 7. Debug\n", "\n# Safety limits on autonomy\n"],
  gemini: ["\n# Core mandates\n", "\n## New applications\n", "\n# Examples\n", "\n# Final reminder\n"],
  kimi: ["\n# Research and data work\n", "\n## Working directory\n", "\n# Final reminders\n"],
  deepseek: ["\n# Tracking work with `task`\n", "\n# Git safety\n", "\n# Code standards\n"],
  glm: ["\n# Harness\n", "\n# Core principles\n"],
  minimax: ["\n# When you are stuck\n", "\n# What you do not do\n"],
  trinity: ["\n# Proactiveness\n", "\n# Tool usage policy\n"],
  general: ["\n## How this works\n"],
}

/* The first words each family's system prompt opens with. */
const OPENING: Record<PromptFamily, string> = {
  anthropic: "You are MCode, a coding agent working inside a user's project",
  gpt: "You are MCode, a coding agent. You and the user share one project",
  beast: "You are MCode, an agent working in a user's project on their machine. Once you start",
  gemini: "You are MCode, an agent for software work in a user's project on their machine. Your job",
  kimi: "You are MCode, a general agent running on the user's computer.\n",
  deepseek: "You are MCode, a coding agent that helps with software work",
  glm: "You are MCode, a general agent running on the user's computer, working on software",
  minimax: "You are MCode, a coding agent that works on software in a user's project",
  trinity: "You are MCode, an agent for software work in a user's project on their machine. Everything below",
  general: "You are MCode, an agent that works on software in a user's project",
}

export async function roundNineChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 9: each model id reads the family prompt MiMo's engine would pick")
  {
    const wrong = EXPECTED.filter(([id, family]) => promptFamily({ id }) !== family)
    check(`all ${EXPECTED.length} representative ids land in their family`, wrong.length === 0, wrong.map(([id]) => `${id} -> ${promptFamily({ id })}`))
    const families = new Set(EXPECTED.map(([, family]) => family))
    check("and between them every family is reached", families.size === Object.keys(FAMILY_PROMPTS).length, [...families])
    for (const [id, family, why] of TRAPS) {
      check(`${why} (${id})`, promptFamily({ id }) === family, promptFamily({ id }))
    }
    check("a turn that names no model reads the general prompt", promptFamily(undefined) === "general")
  }

  section("Round 9: ten prompts, each organised the way its family's is")
  {
    const prompts = Object.entries(FAMILY_PROMPTS) as [PromptFamily, string][]
    check("there are ten, and ten different texts", prompts.length === 10 && new Set(prompts.map(([, text]) => text)).size === 10)
    for (const [family, text] of prompts) {
      const missing = MARK[family].filter((mark) => !text.includes(mark))
      check(`the ${family} prompt keeps the sections it is built around`, missing.length === 0, missing)
      check(`the ${family} prompt opens as that family's does`, text.startsWith(OPENING[family]), text.slice(0, 80))
    }
    check(
      "each names this app and never the reference",
      prompts.every(([, text]) => text.startsWith("You are MCode") && !/mimo/i.test(text)),
    )
    check("each says what a system-reminder is", prompts.every(([, text]) => text.includes("<system-reminder>")))
    check("each says that instructions inside a tool's output are not to be obeyed", prompts.every(([, text]) => text.includes("something to report, never")))
    /* The new seven, against the MiMo files they answer: between half and three quarters of their length. */
    const lengths: [PromptFamily, number, number][] = [
      ["beast", 5_000, 9_000],
      ["gemini", 6_000, 11_000],
      ["kimi", 4_000, 6_500],
      ["deepseek", 6_000, 8_500],
      ["glm", 2_500, 4_000],
      ["minimax", 5_500, 8_500],
      ["trinity", 3_500, 6_000],
    ]
    const off = lengths.filter(([family, low, high]) => FAMILY_PROMPTS[family].length < low || FAMILY_PROMPTS[family].length > high)
    check("the seven new ones are each in the length class of the file they answer", off.length === 0, off.map(([family]) => `${family}: ${FAMILY_PROMPTS[family].length}`))
    check(
      "the Gemini and Trinity prompts carry worked examples, and DeepSeek's does not",
      FAMILY_PROMPTS.trinity.includes("<example>") && FAMILY_PROMPTS.gemini.includes("<example>") && !FAMILY_PROMPTS.deepseek.includes("<example>"),
    )
    check("Trinity alone is told to make one tool call per step", prompts.filter(([, text]) => text.includes("one tool call per step")).map(([family]) => family).join() === "trinity")
  }

  section("Round 9: the provider is sent the family's prompt, byte for byte the same all conversation")
  {
    const ids = ["o3-mini", "gemini-3-pro", "kimi-k2.5", "deepseek-v3.2", "glm-4.6", "MiniMax-M2", "trinity-large"]
    const e = await engine({ custom: { models: ids.map((id) => ({ id, name: id })) } })
    try {
      const firsts: string[] = []
      for (const id of ids) {
        const family = promptFamily({ id })
        const session = await e.store.create({ directory: e.project, model: { provider: "fake", model: id } })
        e.replies.push(say("ok"))
        await e.runner.prompt({ sessionID: session.id, text: "hello" })
        await e.idle(session.id)
        const first = systemOf(e.bodies.at(-1))
        firsts.push(first)
        // Each family's last mark is its own heading; GLM's are all shared with another family, so it is left out here.
        const others = (Object.keys(MARK) as PromptFamily[]).filter((other) => other !== family && other !== "glm")
        check(
          `a ${id} turn opens with the ${family} prompt and carries no other family's`,
          first.startsWith(OPENING[family]) && MARK[family].every((mark) => first.includes(mark)) && others.every((other) => !first.includes(MARK[other][MARK[other].length - 1])),
          first.slice(0, 80),
        )
        check(`and after it, the ${id} prompt has the sections every family shares`, first.includes("## Environment"))
        e.replies.push(say("again"))
        await e.runner.prompt({ sessionID: session.id, text: "second" })
        await e.idle(session.id)
        check(`a second ${id} turn sends the very same prefix`, systemOf(e.bodies.at(-1)) === first)
      }
      check("seven families, seven different prefixes", new Set(firsts.map((text) => text.slice(0, 120))).size === 7)
    } finally {
      await e.close()
    }
  }
}
