/**
 * Round 8: the wording rules the eighteen language tables must keep.
 *
 * Kept apart from smoke.ts the way the round files are; smoke.ts calls
 * `wordingChecks` with its own check and section. Every rule is a pure function
 * of the tables, and each is also run against a copy broken on purpose, so a
 * rule that has quietly stopped matching anything fails here instead of
 * passing forever.
 */
import fs from "node:fs"
import path from "node:path"
import type { Check } from "./smoke-round5"

type Tables = Record<string, Record<string, string>>

/** Reads every `const X: Table = {` out of i18n.ts, the way i18n-check does. */
export function readTables(source: string): Tables {
  const out: Tables = {}
  for (const match of source.matchAll(/^const ([A-Za-z0-9]+): Table = \{$/gm)) {
    const start = (match.index ?? 0) + match[0].length
    const body = source.slice(start, source.indexOf("\n}", start))
    const entries: Record<string, string> = {}
    for (const entry of body.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) {
      entries[entry[1]] = JSON.parse(`"${entry[2]}"`)
    }
    out[match[1]] = entries
  }
  return out
}

function clone(tables: Tables): Tables {
  return Object.fromEntries(Object.entries(tables).map(([name, entries]) => [name, { ...entries }]))
}

/*
 * W1: a table written in another language's script.
 *
 * Twelve tables once carried the diagram menu in Simplified Chinese. A value in
 * a script its language never uses is a copy that was never translated.
 */
const SCRIPTS: Record<string, RegExp> = {
  han: /[㐀-䶿一-鿿]/,
  kana: /[぀-ヿ]/,
  hangul: /[가-힯ᄀ-ᇿ]/,
  cyrillic: /[Ѐ-ӿ]/,
  arabic: /[؀-ۿ]/,
  thai: /[฀-๿]/,
}
const OWN_SCRIPTS: Record<string, string[]> = {
  zhCN: ["han"],
  zhTW: ["han"],
  ja: ["han", "kana"],
  ko: ["hangul"],
  ru: ["cyrillic"],
  uk: ["cyrillic"],
  ar: ["arabic"],
  th: ["thai"],
}

export function foreignScript(tables: Tables): string[] {
  const found: string[] = []
  for (const [name, entries] of Object.entries(tables)) {
    const own = OWN_SCRIPTS[name] ?? []
    for (const [key, value] of Object.entries(entries)) {
      for (const [script, pattern] of Object.entries(SCRIPTS)) {
        if (!own.includes(script) && pattern.test(value)) found.push(`${name} ${key} (${script})`)
      }
    }
  }
  return found
}

/*
 * Han is right in zh-TW and Japanese, so the script rule cannot see a
 * Simplified copy there. These characters exist only in Simplified Chinese -
 * neither Traditional nor Japanese writes them - so one of them in either table
 * is a copy of the zh-CN string. Shared forms (端, 器, 数, 写, 查...) are left out.
 */
const SIMPLIFIED_ONLY = "载图码为这们时发设开关选择览显务话进动从对间应实现还过变输页签链复删编辑标别说请钮项么权获读错误历记录终网络浏个"

export function simplifiedLeftovers(tables: Tables): string[] {
  const found: string[] = []
  for (const name of ["zhTW", "ja"]) {
    for (const [key, value] of Object.entries(tables[name] ?? {})) {
      const hit = [...value].find((character) => SIMPLIFIED_ONLY.includes(character))
      if (hit) found.push(`${name} ${key} (${hit})`)
    }
  }
  return found
}

/*
 * W2: sentences that were still English in eleven tables.
 *
 * The info card's git and pull-request rows, the subagent states, and the
 * browser panel's right-click menu - which the main process draws natively, so
 * an English row there is the most visible island in a Russian interface.
 */
export const MUST_TRANSLATE = [
  "info.prLoading",
  "info.prNone",
  "info.prUnavailable",
  "info.prStatus.open",
  "info.prStatus.draft",
  "info.prStatus.closed",
  "info.prStatus.merged",
  "info.detachedHead",
  "info.branchListUnavailable",
  "info.branchSwitchFailed",
  "info.branchSwitchConflicts",
  "info.loadingBranches",
  "subagentActivity.status.failed",
  "subagentActivity.status.cancelled",
  "subagentActivity.status.stalled",
  "subagentActivity.status.ended",
  "rp.browser.ctx.openLinkNewTab",
  "rp.browser.ctx.copyLink",
  "rp.browser.ctx.copyImage",
  "rp.browser.ctx.copyImageUrl",
  "rp.browser.ctx.back",
  "rp.browser.ctx.forward",
  "rp.browser.ctx.reload",
  "edit.copyImageAddress",
]

export function untranslated(tables: Tables, keys: readonly string[] = MUST_TRANSLATE): string[] {
  const english = tables.en ?? {}
  const found: string[] = []
  for (const [name, entries] of Object.entries(tables)) {
    if (name === "en") continue
    for (const key of keys) {
      if (!(key in english)) found.push(`en ${key} (missing)`)
      else if (entries[key] === english[key]) found.push(`${name} ${key}`)
    }
  }
  return found
}

/*
 * W3: a counted word that hedges its own plural - Datei(en), plik(ów),
 * archivo(s), opis(y/ów), odniesienie(-ia). The tables choose a form instead:
 * a "Files edited: {n}" label, which needs no agreement, or the plain plural.
 * The match is a letter glued to a short lowercase ending in brackets.
 */
const HEDGE = /\p{L}\((?:[-/]?\p{Ll}{1,4}(?:[-/]\p{Ll}{1,4})?)\)/u

export function bracketPlurals(tables: Tables): string[] {
  const found: string[] = []
  for (const [name, entries] of Object.entries(tables)) {
    for (const [key, value] of Object.entries(entries)) {
      const hit = HEDGE.exec(value)
      if (hit) found.push(`${name} ${key} (${hit[0]})`)
    }
  }
  return found
}

/*
 * W4: one name for a conversation.
 *
 * MiMo's centre is 对话 / "conversation" for the thing the user talks in, with
 * 聊天 / "chat" in only a handful of its own strings and 会话 / "session" kept
 * for the engine's object (its id and link, compacting its context, importing,
 * sharing). MCode follows that: 聊天 / "chat" survives only in the side-chat
 * feature's name and in rows that are MiMo's own strings byte for byte, and
 * 会话 / "session" only in those engine rows and in the locked reference keys -
 * which are no longer what any screen draws.
 */
// The fork shortcut row is MiMo's own 分叉聊天 / "Fork chat" again, since W5 was reverted to MiMo's wording.
const MIMO_CHAT_KEYS = new Set(["toast.noConvosToArchive", "toast.archivedNConvos", "set.codeFontSizeSub", "key.label.conv-archive", "key.desc.conv-archive", "key.label.fork-chat", "key.desc.fork-chat"])
const ENGINE_SESSION_KEYS = new Set([
  "stream.chatSourceGone",
  "share.session",
  "set.spineSoundSub",
  "toast.compactFailed",
  "toast.shareFailed",
  "set.displayServerSub",
  "import.running",
  "import.sessions",
  "import.importedExceeds",
  "key.label.copy-deeplink",
  "key.label.copy-session-id",
  "key.desc.copy-deeplink",
  "key.desc.copy-session-id",
  "key.copyID",
  "key.copyLink",
  "menu.copiedLink",
  "menu.linkMissing",
  "menu.copiedID",
  "side.chatLink.jump",
  "composer.compactDesc",
  "menu.noWorkDir",
  "menu.copySessionID",
  "menu.copySessionLink",
  "menu.copiedSessionID",
  "composer.compact.noSession",
  "composer.compact.busy",
  "rp.termClose.message",
  "rp.termClose.batchMessage",
])
/** The locked reference rows that say 会话 / "Session" and that no screen may draw any more. */
export const RETIRED_SESSION_KEYS = [
  "session.new",
  "menu.newSession",
  "cmd.newSession",
  "menu.session",
  "menu.deleteSession",
  "menu.prevSession",
  "menu.nextSession",
  "cmd.searchSessions",
  "search.sessions",
  "search.in.sessions",
  "cmd.prevUnread",
  "cmd.nextUnread",
  "key.prevSession",
  "key.nextSession",
  "key.groupSession",
]

function lockedKeys(): Set<string> {
  const fixture = path.join(process.cwd(), "scripts/fixtures/reference-strings.json")
  return new Set(Object.keys(JSON.parse(fs.readFileSync(fixture, "utf8")) as Record<string, unknown>))
}

export function terminology(tables: Tables, locked: Set<string> = lockedKeys()): string[] {
  const found: string[] = []
  for (const [key, zh] of Object.entries(tables.zhCN ?? {})) {
    if (zh.replace(/侧边聊天/g, "").includes("聊天") && !MIMO_CHAT_KEYS.has(key)) found.push(`zhCN ${key} says 聊天`)
    if (zh.includes("会话") && !locked.has(key) && !ENGINE_SESSION_KEYS.has(key)) found.push(`zhCN ${key} says 会话`)
  }
  for (const [key, en] of Object.entries(tables.en ?? {})) {
    const rest = en.replace(/side chats?/gi, "").replace(/\/chat\//g, "")
    if (/\bchats?\b/i.test(rest) && !MIMO_CHAT_KEYS.has(key) && !key.startsWith("set.keywords.")) found.push(`en ${key} says chat`)
    if (/\bsessions?\b/i.test(en) && !locked.has(key) && !ENGINE_SESSION_KEYS.has(key)) found.push(`en ${key} says session`)
  }
  return found
}

/** Source lines that still draw a retired session row, e.g. t("cmd.newSession") or group: "key.groupSession". */
export function retiredSessionCalls(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|ts)$/.test(entry.name) && entry.name !== "i18n.ts") {
        const text = fs.readFileSync(full, "utf8")
        for (const key of RETIRED_SESSION_KEYS) {
          // session.new is also the id of the new-conversation command; only a string lookup counts.
          const pattern = key === "session.new" ? /\bt\(\s*["'`]session\.new["'`]/ : new RegExp(`["'\`]${key.replace(/\./g, "\\.")}["'\`]`)
          if (pattern.test(text)) found.push(`${path.relative(root, full)} uses ${key}`)
        }
      }
    }
  }
  walk(path.join(root, "src"))
  return found
}

/*
 * W6: relative time is one family.
 *
 * There were four - time.*, art.time*, office.time*, subagents.* - with three
 * English spellings ("5 min ago", "5m ago") and two placeholder names, so the
 * side column, the artifacts page and the subagent list wrote the same moment
 * differently. MiMo has one (lib.minutesAgo / hoursAgo / daysAgo / justNow).
 */
export const TIME_KEYS = ["time.justNow", "time.minutesAgo", "time.hoursAgo", "time.daysAgo"]
/* The counted three are stored once per plural form (tn); every form belongs to the family. */
const PLURAL_FORMS = ["one", "few", "many", "other", "two", "zero"]
const COUNTED = TIME_KEYS.filter((key) => key !== "time.justNow")
const familyKey = (key: string) => TIME_KEYS.includes(key) || COUNTED.some((base) => PLURAL_FORMS.some((form) => key === `${base}_${form}`))
const ENGLISH_TIME: Record<string, string> = {
  "time.justNow": "Just now",
  "time.minutesAgo": "{count} min ago",
  "time.hoursAgo": "{count} h ago",
  "time.daysAgo": "{count} d ago",
}

export function relativeTimeFamilies(tables: Tables): string[] {
  const found: string[] = []
  for (const [key, value] of Object.entries(tables.zhCN ?? {})) {
    if (familyKey(key)) continue
    if (value === "刚刚" || /^\{\w+\} ?(分钟?|小时|天)前$/.test(value)) found.push(`zhCN ${key} is a second relative-time string`)
  }
  for (const [key, value] of Object.entries(tables.en ?? {})) {
    if (familyKey(key)) continue
    if (/^just now$/i.test(value) || /^\{\w+\} ?(m|min|minutes?|h|hours?|d|days?) ago$/i.test(value)) found.push(`en ${key} is a second relative-time string`)
  }
  for (const key of TIME_KEYS) {
    // English has no dual or paucal, so every form of a counted key reads the one spelling.
    const stored = key === "time.justNow" ? [key] : PLURAL_FORMS.map((form) => `${key}_${form}`)
    for (const name of stored) {
      if (tables.en?.[name] !== ENGLISH_TIME[key]) found.push(`en ${name} reads ${JSON.stringify(tables.en?.[name])}`)
      for (const [table, entries] of Object.entries(tables)) {
        const holes = [...(entries[name] ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).join(",")
        // Arabic's one and two say the count in the word itself (دقيقة / دقيقتين), so a form may drop it.
        if (entries[name] === undefined) found.push(`${table} ${name} (missing)`)
        else if (holes !== "" && (key === "time.justNow" || holes !== "count")) found.push(`${table} ${name} has placeholders [${holes}]`)
        else if (holes === "" && key !== "time.justNow" && name.endsWith("_other")) found.push(`${table} ${name} does not say the count`)
      }
    }
  }
  return found
}

export function wordingChecks(check: Check, section: (name: string) => void): void {
  const source = fs.readFileSync(path.join(process.cwd(), "src/renderer/src/lib/i18n.ts"), "utf8")
  const tables = readTables(source)

  section("Round 8 (W1): every table is written in its own language's script")
  {
    check("all eighteen tables were read", Object.keys(tables).length === 18, Object.keys(tables))
    const foreign = foreignScript(tables)
    check("no table carries a string in a script its language does not use", foreign.length === 0, foreign.slice(0, 8))
    const simplified = simplifiedLeftovers(tables)
    check("zh-TW and Japanese carry no Simplified-only character", simplified.length === 0, simplified.slice(0, 8))

    // Each rule, against the defect it was written for.
    const broken = clone(tables)
    broken.de["svgMenu.viewCode"] = "查看代码"
    broken.ru["svgMenu.copyCode"] = "Copy code 코드"
    const caught = foreignScript(broken)
    check(
      "the script rule catches a Chinese string in German and Hangul in Russian",
      caught.includes("de svgMenu.viewCode (han)") && caught.includes("ru svgMenu.copyCode (hangul)"),
      caught,
    )
    const zh = clone(tables)
    zh.zhTW["svgMenu.downloadImage"] = "下载为图片"
    zh.ja["svgMenu.downloadSvg"] = "下载到本地"
    const leftovers = simplifiedLeftovers(zh)
    check(
      "the Simplified rule catches a zh-CN copy in zh-TW and in Japanese",
      leftovers.some((line) => line.startsWith("zhTW svgMenu.downloadImage")) && leftovers.some((line) => line.startsWith("ja svgMenu.downloadSvg")),
      leftovers,
    )
    check("and leaves the characters the three scripts share alone", simplifiedLeftovers({ zhTW: { a: "終端機 伺服器 查看" }, ja: { b: "数を写す" } }).length === 0)
  }

  section("Round 8 (W2): the git rows, subagent states and browser menu are translated everywhere")
  {
    const english = untranslated(tables)
    check("none of them reads as English outside the English table", english.length === 0, english.slice(0, 8))
    const broken = clone(tables)
    broken.ru["rp.browser.ctx.reload"] = broken.en["rp.browser.ctx.reload"]
    check("the rule catches an English row in the Russian menu", untranslated(broken).includes("ru rp.browser.ctx.reload"))
  }

  section("Round 8 (W3): no counted string hedges its plural in brackets")
  {
    const hedges = bracketPlurals(tables)
    check("no table writes Datei(en), plik(ów) or archivo(s)", hedges.length === 0, hedges.slice(0, 8))
    const broken = clone(tables)
    broken.de["stream.editedCard"] = "{n} Datei(en) bearbeitet"
    broken.pl["annotations.chip"] = "{count} opis(y/ów)"
    broken.pl["annotations.refsMore"] = "+{count} odniesienie(-ia)"
    const caught = bracketPlurals(broken)
    check(
      "the rule catches the German, and both Polish forms",
      ["de stream.editedCard", "pl annotations.chip", "pl annotations.refsMore"].every((line) => caught.some((hit) => hit.startsWith(line))),
      caught,
    )
    check(
      "and leaves a bracketed count, a placeholder and an abbreviation alone",
      bracketPlurals({ x: { a: "Vis flere filer ({n})", b: "{cur}/{total} (+{hidden})", c: "vor {n} Tg. (PDF)" } }).length === 0,
    )
  }

  section("Round 8 (W4): a conversation has one name")
  {
    const loose = terminology(tables)
    check("聊天 / chat and 会话 / session appear only where MiMo or the engine keeps them", loose.length === 0, loose.slice(0, 8))
    const calls = retiredSessionCalls(process.cwd())
    check("no screen draws a locked 会话 / Session row any more", calls.length === 0, calls)
    for (const key of ["key.groupConversation", "conv.prev", "conv.next", "conv.search", "conv.prevUnread", "conv.nextUnread"]) {
      const absent = Object.keys(tables).filter((name) => !tables[name][key])
      check(`${key} is written in every table`, absent.length === 0, absent)
    }
    const broken = clone(tables)
    broken.zhCN["cmd.archive"] = "归档此会话"
    broken.en["art.back"] = "Open chat"
    broken.zhCN["launch.chat"] = "侧边聊天"
    const caught = terminology(broken)
    check(
      "the rule catches 会话 on an archive row and chat on a button, and lets the side chat keep its name",
      caught.includes("zhCN cmd.archive says 会话") && caught.includes("en art.back says chat") && !caught.some((line) => line.includes("launch.chat")),
      caught,
    )
  }

  section("Round 8 (W6): relative time is one family with one English spelling")
  {
    const extra = relativeTimeFamilies(tables)
    check("only time.justNow / minutesAgo / hoursAgo / daysAgo say how long ago", extra.length === 0, extra.slice(0, 8))
    const broken = clone(tables)
    broken.zhCN["art.timeM"] = "{n} 分钟前"
    broken.en["art.timeM"] = "{n}m ago"
    broken.en["time.hoursAgo_other"] = "{count}h ago"
    const caught = relativeTimeFamilies(broken)
    check(
      "the rule catches a second family and a second English spelling",
      caught.includes("zhCN art.timeM is a second relative-time string") && caught.includes("en art.timeM is a second relative-time string") && caught.some((line) => line.startsWith("en time.hoursAgo_other reads")),
      caught,
    )
  }
}
