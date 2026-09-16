/**
 * Round 7: what the model actually receives, measured against MiMo's engine.
 *
 * Kept apart from smoke.ts the way rounds 5 and 6 are; smoke.ts calls
 * `roundSevenChecks` with its own check and section. The pure rules are checked
 * directly, and the ones that only matter on the wire are read back out of the
 * fake provider's own request bodies - a trimmed result is only trimmed if the
 * provider saw it trimmed.
 */
import { Identifier } from "../src/shared/id"
import type { AssistantMessage, Message, ToolPart, UserMessage } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"
import { engine, say } from "./smoke-round5"
// M5: the local token estimate everything else sizes itself with.
import { CHARS_PER_TOKEN, estimateTokens, formatQuantity, parseQuantity } from "../src/server/session/estimate"
// M4: trimming what a turn re-sends.
import {
  DEFAULT_CACHE_TTL_MS,
  PRUNE_MINIMUM,
  PRUNE_PROTECT,
  SOFT_TRIM_KEEP_HEAD,
  SOFT_TRIM_KEEP_TAIL,
  SOFT_TRIM_THRESHOLD,
  isCacheCold,
  pressureLevel,
  pruneCandidates,
  pruneLevelFor,
  prunedHistory,
  softTrim,
} from "../src/server/session/prune"
import { contextCount } from "../src/server/session/overflow"

/** A finished tool call carrying `output`, as a completed step leaves one. */
function toolPart(name: string, output: string): ToolPart {
  return {
    type: "tool",
    id: Identifier.part(),
    callID: `call_${Identifier.part()}`,
    name,
    status: "completed",
    input: {},
    output,
    time: { created: 1, completed: 2 },
  }
}

function user(sessionID: string, text: string, at: number): UserMessage {
  return { id: Identifier.message(), sessionID, role: "user", text, attachments: [], time: { created: at } }
}

function assistant(sessionID: string, parts: AssistantMessage["parts"], at: number, input = 0): AssistantMessage {
  return {
    id: Identifier.message(),
    sessionID,
    role: "assistant",
    model: { provider: "fake", model: "m" },
    agent: "build",
    parts,
    finish: "end_turn",
    ...(input ? { usage: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } : {}),
    time: { created: at, completed: at },
  }
}

export async function roundSevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------------ M5
  section("Round 7 (M5): the local token estimate")
  {
    check("four characters to a token, as MiMo counts", CHARS_PER_TOKEN === 4)
    check("nothing is nothing", estimateTokens("") === 0 && estimateTokens(undefined) === 0)
    check("and it rounds rather than truncating", estimateTokens("abcdef") === 2, estimateTokens("abcdef"))
    check("a long string is its length over four", estimateTokens("x".repeat(4_000)) === 1_000)

    check("a plain number is taken as a count", parseQuantity(1234) === 1234)
    check("a negative or broken number is not a quantity", parseQuantity(-5) === undefined && parseQuantity(Number.NaN) === undefined)
    check("K is a thousand and M a million, as MiMo reads them", parseQuantity("40K") === 40_000 && parseQuantity("1.5M") === 1_500_000)
    check("a percentage needs something to be a percentage of", parseQuantity("20%") === undefined && parseQuantity("20%", 1_000) === 200)
    check("and an impossible percentage is refused", parseQuantity("0%", 100) === undefined && parseQuantity("120%", 100) === undefined)
    check("anything else is not a quantity", parseQuantity("soon") === undefined && parseQuantity("40KB") === undefined)
    check("a count reads back the way MiMo writes it", formatQuantity(40_000) === "40K" && formatQuantity(1_500_000) === "1.5M" && formatQuantity(12) === "12")
  }

  // ------------------------------------------------------------------ M4
  section("Round 7 (M4): pruning only runs on a cold cache, and only under pressure")
  {
    const now = 1_000_000_000
    check("a conversation with no reply yet counts as cold", isCacheCold(undefined, undefined, now))
    check("a reply a moment ago leaves the cache warm", !isCacheCold(now - 1_000, undefined, now))
    check(
      "past MiMo's five-minute default it is cold",
      isCacheCold(now - (DEFAULT_CACHE_TTL_MS + 1), undefined, now) && DEFAULT_CACHE_TTL_MS === 300_000,
    )
    check("a model asking for the hour-long cache stays warm far longer", !isCacheCold(now - 600_000, "1h", now))

    // usable = floor(10000 * 0.9) = 9000, so the bands fall at 4500 / 6300 / 7650.
    const entry = { contextWindow: 10_000 }
    const at = (input: number) => pressureLevel({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, entry)
    check("under half the usable window there is no pressure", at(4_000) === 0)
    check("past half, level 1", at(5_000) === 1)
    check("past 0.7, level 2", at(6_500) === 2)
    check("past 0.85, level 3", at(8_000) === 3)
    check(
      "a model whose window is unknown never reports pressure",
      pressureLevel({ input: 8_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, { contextWindow: 0 }) === 0,
    )
    check(
      "the count is the same five figures the overflow trigger adds up",
      contextCount({ input: 1, output: 2, reasoning: 4, cacheRead: 8, cacheWrite: 16 }) === 31,
    )

    const tokens = { input: 8_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    check(
      "a warm cache prunes nothing however full the window is",
      pruneLevelFor({ tokens, entry, lastAssistantAt: now - 1_000, now }) === 0,
    )
    check(
      "cold and half full soft-trims (level 1)",
      pruneLevelFor({ tokens: { ...tokens, input: 5_000 }, entry, lastAssistantAt: now - 600_000, now }) === 1,
    )
    check("cold and nearly full clears (level 2)", pruneLevelFor({ tokens, entry, lastAssistantAt: now - 600_000, now }) === 2)
  }

  section("Round 7 (M4): the soft trim keeps the head and the tail")
  {
    check("a short result is left exactly as it was", softTrim("hello") === "hello")
    const short = "y".repeat(SOFT_TRIM_THRESHOLD)
    check("and so is one right on the threshold", softTrim(short) === short)

    const long = "A".repeat(3_000) + "MIDDLE" + "B".repeat(3_000)
    const trimmed = softTrim(long)
    /*
     * Both halves assert the exact boundary, not merely "starts with 1,536 A's":
     * an untrimmed 3,000-A string satisfies that too, so the loose form passed
     * even with trimming switched off entirely.
     */
    check(
      "a long one keeps MiMo's first 1,536 characters and no more",
      trimmed.startsWith("A".repeat(SOFT_TRIM_KEEP_HEAD)) && !trimmed.startsWith("A".repeat(SOFT_TRIM_KEEP_HEAD + 1)),
    )
    check(
      "and its last 1,536, exactly",
      trimmed.endsWith("B".repeat(SOFT_TRIM_KEEP_TAIL)) && !trimmed.endsWith("B".repeat(SOFT_TRIM_KEEP_TAIL + 1)),
    )
    check("the middle is gone", !trimmed.includes("MIDDLE"))
    check("the note says how long the whole thing was", trimmed.includes(String(long.length)))
    check("and the result is shorter than what it replaced", trimmed.length < long.length)
  }

  section("Round 7 (M4): what may be pruned, and what is protected")
  {
    const s = "s1"
    const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 40_000)
    const history: Message[] = [
      user(s, "one", 1),
      assistant(s, [toolPart("bash", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "recent output")], 4),
      user(s, "three", 5),
    ]
    const found = pruneCandidates(history)
    check("the old result past the protected tail is a candidate", found.parts.length === 1 && found.parts[0]?.output === big, found.parts.length)
    check("and clearing it would reclaim its whole estimate", found.reclaimable === estimateTokens(big))

    const newest = pruneCandidates([user(s, "one", 1), assistant(s, [toolPart("bash", big)], 2), user(s, "two", 3)])
    check("the newest turn is never a candidate, however large", newest.parts.length === 0, newest.parts.length)

    const skill = pruneCandidates([
      user(s, "one", 1),
      assistant(s, [toolPart("skill", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "x")], 4),
      user(s, "three", 5),
    ])
    check("a loaded skill is never pruned, being instructions rather than output", skill.parts.length === 0, skill.parts.length)

    // Everything here fits inside the protected tail, so nothing is a candidate.
    const small = pruneCandidates([
      user(s, "one", 1),
      assistant(s, [toolPart("bash", "a".repeat(400))], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "b")], 4),
      user(s, "three", 5),
    ])
    check("output inside the protected tail is left alone", small.parts.length === 0, small.parts.length)
  }

  section("Round 7 (M4): the two levels, and the floor under clearing")
  {
    const s = "s2"
    const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 200_000)
    /*
     * Five turns, because MiMo's strip keeps the newest three: the reasoning in
     * the first reply is only old enough to be stripped once four user messages
     * stand after it.
     */
    const build = (): Message[] => [
      user(s, "one", 1),
      assistant(s, [{ type: "reasoning", id: "r1", text: "old thinking", time: { created: 1 } }, toolPart("bash", big)], 2),
      user(s, "two", 3),
      assistant(s, [toolPart("bash", "second")], 4),
      user(s, "three", 5),
      assistant(s, [toolPart("bash", "third")], 6),
      user(s, "four", 7),
      assistant(s, [toolPart("bash", "recent")], 8),
      user(s, "five", 9),
    ]
    const newest = 7

    const original = build()
    const before = JSON.stringify(original)
    check("level 0 changes nothing at all", JSON.stringify(prunedHistory(original, 0)) === before)

    const one = prunedHistory(build(), 1)
    const oneOut = (one[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("level 1 soft-trims the old result", oneOut.length < big.length && oneOut.includes("left out the middle"), oneOut.length)
    check("level 1 leaves the newest turn whole", (one[newest] as AssistantMessage).parts.some((p) => p.type === "tool" && p.output === "recent"))
    check("level 1 keeps old reasoning, which only level 2 strips", (one[1] as AssistantMessage).parts.some((p) => p.type === "reasoning" && p.text === "old thinking"))

    const two = prunedHistory(build(), 2)
    const twoOut = (two[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("level 2 clears the old result outright", twoOut.includes("cleared this older bash result") && twoOut.length < 200, twoOut.slice(0, 80))
    check("level 2 strips the reasoning of the turns before the last three", (two[1] as AssistantMessage).parts.some((p) => p.type === "reasoning" && p.text === ""))
    check("level 2 still leaves the newest turn whole", (two[newest] as AssistantMessage).parts.some((p) => p.type === "tool" && p.output === "recent"))

    /*
     * MiMo's floor: past the protected tail but with less than PRUNE_MINIMUM to
     * reclaim, clearing rewrites the prefix for too little, so it does not.
     *
     * The filler is exactly the protected tail, so only the small result behind
     * it tips over the line - and it alone is not worth clearing.
     */
    const filler = "z".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN)
    const barely: Message[] = [
      user("s3", "one", 1),
      assistant("s3", [toolPart("bash", "y".repeat(4_000))], 2),
      user("s3", "two", 3),
      assistant("s3", [toolPart("bash", filler)], 4),
      user("s3", "three", 5),
      assistant("s3", [toolPart("bash", "recent")], 6),
      user("s3", "four", 7),
    ]
    const reclaim = pruneCandidates(barely).reclaimable
    const kept = prunedHistory(barely, 2)
    const keptOut = (kept[1] as AssistantMessage).parts.find((p): p is ToolPart => p.type === "tool")?.output ?? ""
    check("only what is past the protected tail counts as reclaimable", reclaim === 1_000, reclaim)
    check("too little to reclaim, so level 2 clears nothing", reclaim < PRUNE_MINIMUM && !keptOut.includes("cleared"), reclaim)
  }

  // -------------------------------------------------- M4 on the wire
  section("Round 7 (M4): a trimmed result as the provider receives it")
  {
    // The window has to be stated as MiMo's `limit.context`: `customModelOf` keeps that and drops anything else.
    const e = await engine({ custom: { models: [{ id: "m", name: "M", limit: { context: 10_000 } }] } })
    try {
      const stale = Date.now() - 10 * 60 * 1000
      const big = "x".repeat(PRUNE_PROTECT * CHARS_PER_TOKEN + 200_000)

      /**
       * A conversation whose older turn read something large, with its last
       * reply far enough back that the prompt cache has expired.
       *
       * `input` decides the pressure: the usable window is 9,000, so 5,000 is
       * level 1 and 8,000 is level 2.
       */
      const seed = async (input: number, when: number) => {
        const session = await e.store.create({ directory: e.project, model: e.model })
        for (const message of [
          user(session.id, "read the big file", when),
          assistant(session.id, [toolPart("bash", big)], when),
          user(session.id, "thanks", when),
          assistant(session.id, [toolPart("bash", "the newest result")], when, input),
        ]) {
          await e.store.saveMessage(message)
        }
        return session.id
      }

      const cold = await seed(5_000, stale)
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: cold, text: "carry on" })
      await e.idle(cold)
      const sent = JSON.stringify(e.bodies.at(-1) ?? {})
      check("the provider is not sent the whole old result", !sent.includes("x".repeat(5_000)), sent.length)
      check("it is sent the trimmed form instead", sent.includes("left out the middle"))
      check("and the newest turn's result still arrives whole", sent.includes("the newest result"))

      const hot = await seed(5_000, Date.now())
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: hot, text: "carry on" })
      await e.idle(hot)
      const warm = JSON.stringify(e.bodies.at(-1) ?? {})
      check("a warm cache is still sent everything, since trimming it would cost more than it saves", warm.includes("x".repeat(5_000)))

      const full = await seed(8_000, stale)
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: full, text: "carry on" })
      await e.idle(full)
      const cleared = JSON.stringify(e.bodies.at(-1) ?? {})
      check("under real pressure the old result is cleared, not merely trimmed", cleared.includes("cleared this older bash result"), cleared.length)
      check("the newest turn survives that too", cleared.includes("the newest result"))
    } finally {
      await e.close()
    }
  }
}
