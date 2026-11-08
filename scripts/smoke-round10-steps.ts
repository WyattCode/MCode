/**
 * Round 10: how a turn's steps are drawn, item by item against MiMo 26.914
 * (K10-1 … K10-16). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundTenStepsChecks` with its own check and section. The
 * pure rules are called directly; what only a window shows is left to the
 * Electron probe.
 */
import type { Check } from "./smoke-round5"
import type { AssistantPart, Message, ToolPart, UserMessage } from "../src/shared/protocol"
import { cleanLiveReply, cleanReply, isDotsOnly, saysSomething } from "../src/shared/reply-clean"
import { opensTurn, turnOpeners } from "../src/shared/steer"
import { buildRows, groupSummary, stagesOf } from "../src/renderer/src/lib/step-rows"
import { cutTitle, noOutput, pathTitleParts, showsPath, stepImages, toolIcon } from "../src/renderer/src/lib/tool-meta"
import { language, tn } from "../src/renderer/src/lib/i18n"
import { redactText, redactValue, validCardNumber, validChineseID } from "../src/shared/display-redact"

const tool = (id: string, name: string, status: ToolPart["status"] = "completed", extra: Partial<ToolPart> = {}): ToolPart =>
  ({ type: "tool", id, callID: `call_${id}`, name, status, input: {}, time: { created: 1 }, ...extra }) as ToolPart
const text = (id: string, words: string): AssistantPart => ({ type: "text", id, text: words }) as AssistantPart

export async function roundTenStepsChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 10 (K10-6): leaked markup and lone ellipses")
  {
    check("a leaked thinking block is removed", cleanReply("<think>plan it</think>The answer.") === "The answer.")
    check("so is a tool call written as text", cleanReply("Before <tool_call>{\"name\":\"read\"}</tool_call> after") === "Before  after")
    check("an unclosed opener cuts the rest", cleanReply("Visible.\n<tool_call>{\"name\":") === "Visible.")
    check("a function-style call is removed", cleanReply("A<function=read><parameter=path>x</parameter></function>B") === "AB")
    check("a stray closing tag is dropped", cleanReply("done</think>") === "done")
    check("a parameter left on its own is removed", cleanReply("x <parameter=path>a</parameter> y") === "x  y")
    check("markup inside a fenced block stays", cleanReply("```xml\n<think>kept</think>\n```") === "```xml\n<think>kept</think>\n```")
    check("and inside an inline code span", cleanReply("Use `<tool_call>` tags.") === "Use `<tool_call>` tags.")
    check("blank runs are squeezed and line ends trimmed", cleanReply("a  \n\n\n\nb") === "a\n\nb")
    check("an ellipsis alone is no step", isDotsOnly(" … ") && isDotsOnly("。。。") && isDotsOnly("..."))
    check("words with dots are", !isDotsOnly("ok..."))
    check("a thinking block alone says nothing", !saysSomething("<think>only this</think>"))
    check("a live reply holds back a tag still arriving", cleanLiveReply("Working <tool_ca") === "Working")
    check("a live reply keeps its line breaks, which the renderer's open last line depends on", cleanLiveReply("a\n**b**\n") === "a\n**b**\n")
    check("and loses only the markup", cleanLiveReply("<think>x</think>ok\n") === "ok\n")
    check("but not an ordinary less-than", cleanLiveReply("a <b") === "a <b")
    check("nor one inside a code block still being written", cleanLiveReply("```\nx <tool_ca") === "```\nx <tool_ca")
  }

  section("Round 10 (K10-3, K10-6, K10-13): what becomes a row")
  {
    const rows = buildRows([
      tool("r1", "read"),
      text("t1", "…"),
      tool("r2", "read"),
      tool("a1", "actor", "completed", { input: { action: "run", description: "look" } }),
      tool("r3", "read"),
      tool("q1", "question", "running"),
      tool("r4", "read"),
    ])
    const shape = rows.map((row) => (row.kind === "group" ? `${row.actor ? "A" : "G"}${row.items.length}` : row.kind)).join(",")
    check("a lone ellipsis does not break a group", shape.startsWith("G2,"), shape)
    check("a subagent call is a group of its own, closing and closed by other calls", shape === "G2,A1,G2", shape)
    const answered = buildRows([tool("q2", "question", "completed"), tool("r5", "read")])
    check("an answered question is still its own row", answered.map((row) => row.kind).join() === "question,group")

    const groupOf = (...parts: ToolPart[]) => {
      const row = buildRows(parts).find((entry) => entry.kind === "group")
      return row?.kind === "group" ? row.items : []
    }

    // The summary counts files, not rows. A failed edit has no title from the server, so its row says the path as written and the retry says the project-relative one.
    const edited = (id: string, file: string, ok: boolean) =>
      tool(id, "edit", ok ? "completed" : "error", { input: { filePath: file }, ...(ok ? { title: "../../ChatGPT/DShop/src/" + file.split(/[\\/]/).pop() } : {}) })
    const counts = (...parts: ToolPart[]) => groupSummary(groupOf(...parts))
    const editCount = (...parts: ToolPart[]) => counts(...parts).find((entry) => entry.bucket === "edit")?.count
    check(
      "a failed edit and its retry are one file, whichever way the path was spelled",
      editCount(
        edited("f1", "D:\\Documents\\ChatGPT\\DShop\\src\\catalog.mjs", false),
        edited("f2", "D:/Documents/ChatGPT/DShop/src/catalog.mjs", true),
        edited("f3", "D:\\Documents\\ChatGPT\\DShop\\src\\quote-validity.mjs", false),
        edited("f4", "D:\\Documents\\ChatGPT\\DShop\\src\\quote-validity.mjs", true),
        edited("f5", "D:\\Documents\\ChatGPT\\DShop\\src\\cadence.mjs", true),
      ) === 3,
      String(editCount(edited("f1", "D:\\a\\catalog.mjs", false), edited("f2", "D:/a/catalog.mjs", true))),
    )
    check("two different files stay two", editCount(edited("f6", "D:/p/a.mjs", true), edited("f7", "D:/p/b.mjs", true)) === 2)
    check("reading counts the same way", counts(tool("f8", "read", "completed", { input: { filePath: "D:\\p\\a.mjs" } }), tool("f9", "read", "completed", { input: { path: "D:/p/a.mjs" } }))[0]?.count === 1)
    check("a call with no path of its own is told apart by its title", editCount(tool("g1", "apply_patch", "completed", { title: "one.mjs" }), tool("g2", "apply_patch", "completed", { title: "two.mjs" })) === 2)
  }

  section("Round 10 (K10-1): MiMo's stages")
  {
    const kinds = ["work", "say", "work", "work", "say", "say"]
    const stages = stagesOf(kinds, (kind) => kind === "say")
    check(
      "work then words make a stage, and work after words starts the next",
      JSON.stringify(stages) === JSON.stringify([
        { start: 0, progressEnd: 1, end: 2 },
        { start: 2, progressEnd: 4, end: 6 },
      ]),
      stages,
    )
    const quiet = stagesOf(["say", "work"], (kind) => kind === "say")
    check("a last stage that said nothing ends where its work ends", JSON.stringify(quiet.at(-1)) === JSON.stringify({ start: 1, progressEnd: 2, end: 2 }), quiet)
    check("words alone are one stage with nothing to fold", JSON.stringify(stagesOf(["say"], (kind) => kind === "say")) === JSON.stringify([{ start: 0, progressEnd: 0, end: 1 }]))
  }

  section("Round 10 (K10-2): a taken steer opens a turn")
  {
    const user = (id: string, extra: Record<string, unknown> = {}) =>
      ({ id, sessionID: "s", role: "user", text: id, attachments: [], time: { created: 1 }, ...extra }) as Message
    const reply = (id: string) => ({ id, sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [], time: { created: 1 } }) as Message
    const thread = [user("q1"), reply("a1"), user("s1", { steered: true }), reply("a2"), user("s2", { steered: true }), user("n1", { steered: true, notices: [{ sessionID: "c", subagentID: "x", description: "d", status: "completed" }] })]
    const live = [...turnOpeners(thread, false)].sort().join()
    check("while running: the question and the taken steer open turns, the waiting steer and the notice do not", live === "q1,s1", live)
    const settled = [...turnOpeners(thread, true)].sort().join()
    check("with nothing running the untaken steer is a question of its own", settled === "q1,s1,s2", settled)
    check("an ordinary message always opens one", opensTurn(user("x") as UserMessage, false, false))
  }

  section("Round 10 (K10-5): what a step shows is masked, beyond MiMo")
  {
    const said = redactText("Authorization: Bearer abc.def.ghi and api_key=HUSH12345 with sk-abcdefghijklmnop1234")
    check("a bearer credential, a named key and a prefixed key are masked", said === "Authorization: Bearer [token] and api_key=[token] with [key]", said)
    check("a JWT is masked", redactText("t eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl") === "t [jwt]")
    check("GitHub, AWS and Google keys are masked", redactText(`ghp_${"a".repeat(36)} AKIAABCDEFGHIJKLMNOP AIza${"b".repeat(35)}`) === "[key] [key] [key]")
    check("a long value under a short name is masked", redactText(`token: ${"Z".repeat(20)}`) === "token: [redacted]")
    check("an ID number with a valid check character is masked", redactText("id 11010519491231002X.") === "id [idcard].")
    check("one whose check character is wrong is not", redactText("id 110105194912310021") === "id 110105194912310021")
    check("a card number passing Luhn is masked", redactText("card 4111 1111 1111 1111") === "card [bankcard]")
    check("a long number failing Luhn is not", redactText("order 4111111111111112") === "order 4111111111111112")
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident"
    check("a recovery phrase after its label is masked", redactText(`mnemonic: ${phrase}`) === "mnemonic: [mnemonic]")
    check("ordinary words are left alone", redactText("the key point is simple") === "the key point is simple")
    check("an input is masked four levels deep and not changed in place", (() => {
      const input = { a: { b: { c: "sk-abcdefghijklmnop" } }, list: ["Bearer xyz"] }
      const shown = redactValue(input)
      return shown.a.b.c === "[key]" && shown.list[0] === "Bearer [token]" && input.a.b.c === "sk-abcdefghijklmnop"
    })())
    check("validChineseID reads the check character", validChineseID("11010519491231002X") && !validChineseID("11010519491231002Y"))
    check("validCardNumber wants an issuer's length", validCardNumber("4111111111111111") && !validCardNumber("4111111111111"))
  }

  section("Round 10 (K10-4, K10-8, K10-9, K10-12): one step's pieces")
  {
    const images = stepImages([
      { path: "C:/p/a.png", mime: "", data: "", byPath: true },
      { path: "C:/p/a.svg", mime: "", data: "", byPath: true },
      { path: "x", mime: "image/png", data: "AAAA" },
      { path: "y", mime: "image/svg+xml", data: "AAAA" },
      { path: "z", mime: "application/pdf", data: "AAAA" },
    ])
    check("pictures a call handed back, SVG and other files left out", images.map((item) => item.path).join() === "C:/p/a.png,x", images)
    check("(no output) in its spellings is no output", noOutput("(no output)") && noOutput("  [No Output] ") && noOutput("no output"))
    check("anything more is output", !noOutput("no output here") && !noOutput(""))
    const icons = ["skill", "skill_search", "memory", "pdf_locate", "present_files", "contacts", "actor"].map((name) => toolIcon(name)).join()
    check("step icons follow MiMo's table", icons === "skill,skill,memory,search,fallback,actor,actor", icons)
    const rows = buildRows([
      tool("b1", "bash", "completed", { metadata: { interactive: true } }),
      tool("b2", "bash", "completed", { metadata: { interactive: true } }),
    ])
    const items = rows[0]?.kind === "group" ? rows[0].items.map((item) => item.kind).join() : ""
    check("a command skipped for wanting input gets MiMo's i row, once per turn", items === "tool,notice,tool", items)
  }

  section("Round 10 (K10-15): Arabic dual and zero")
  {
    const before = language.value
    language.value = "ar"
    const two = tn("buildWorkDisplay.read", 2)
    const zero = tn("buildWorkDisplay.read", 0)
    const three = tn("buildWorkDisplay.read", 3)
    language.value = "en"
    const english = tn("buildWorkDisplay.read", 2)
    language.value = before
    check("two files read in Arabic is the dual", two === "تمت قراءة ملفين", two)
    check("none is its own form", zero === "لم تتم قراءة أي ملف", zero)
    check("three keeps the plural", three === "تمت قراءة 3 ملفات", three)
    check("other languages keep their plural", english.includes("2"), english)
  }

  section("Round 10 (K10-16): a long path keeps its file name")
  {
    const deep = "C:\\Users\\Wyatt\\AppData\\Roaming\\mcode\\memory\\sessions\\ses_01a1abf424420000\\notes.md"
    check("the folders are the head and the separator with the file name the tail", JSON.stringify(pathTitleParts(deep, 120)) === JSON.stringify({ head: "C:\\Users\\Wyatt\\AppData\\Roaming\\mcode\\memory\\sessions\\ses_01a1abf424420000", tail: "\\notes.md" }), pathTitleParts(deep, 120))
    const posix = pathTitleParts("/home/w/src/app/main.ts", 120)
    check("a slash path splits the same way", posix.head === "/home/w/src/app" && posix.tail === "/main.ts", posix)
    const cut = pathTitleParts(deep, 60)
    check("past the cap only the folders are cut, with a dot where", cut.tail === "\\notes.md" && cut.head.endsWith("…") && cut.head.length + cut.tail.length === 60, cut)
    check("a bare file name is all head", JSON.stringify(pathTitleParts("main.ts", 90)) === JSON.stringify({ head: "main.ts", tail: "" }))
    check("a name at the root has nothing to cut", pathTitleParts("/main.ts", 90).tail === "")
    const long = pathTitleParts(`C:\\x\\${"n".repeat(100)}.md`, 90)
    check("a file name that fills the row alone is cut at its end", long.tail === "" && long.head.length === 90 && long.head.endsWith("…"), long)
    const pair = "😀".repeat(50)
    const sliced = cutTitle(pair, 11)
    check("a cut never splits a surrogate pair", sliced === `${"😀".repeat(5)}…` && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(sliced), sliced)
    check("a title within the cap is untouched", cutTitle("abc", 3) === "abc")
    check("only path tools are drawn as paths", showsPath("read") && showsPath("edit") && showsPath("write") && showsPath("list") && !showsPath("grep") && !showsPath("bash"))
  }
}
