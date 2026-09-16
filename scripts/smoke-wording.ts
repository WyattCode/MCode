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
 * W5: forking a conversation is not a git branch.
 *
 * The reply row's fork button sits pixels from the git branch chip, and both
 * used to read 分支 / "Branch". Each table names the git branch with one word;
 * none of the fork strings may use it. (MiMo itself writes 分支 for both, so this
 * is MCode's own separation.)
 */
const GIT_BRANCH: Record<string, RegExp> = {
  zhCN: /分支/,
  zhTW: /分支/,
  en: /branch/i,
  ar: /فرع|فروع/,
  bs: /gran[aeiu]/i,
  da: /gren/i,
  de: /branch/i,
  es: /(^|\s)ramas?(\s|$|[,.])/i,
  fr: /branche/i,
  ja: /ブランチ/,
  ko: /브랜치/,
  nb: /gren/i,
  pl: /gałąź|gałęz/i,
  ptBR: /branch/i,
  ru: /ветк/i,
  th: /บรานช์|สาขา/,
  tr: /(^|\s)dal/i,
  uk: /гілк|гілок/i,
}
export const FORK_KEYS = [
  "stream.replyFork",
  "menu.fork",
  "stream.forkedFrom",
  "stream.forkedFromHere",
  "stream.forkedFromCurrent",
  "stream.forkFailed",
  "stream.forkNeedsMessage",
  "key.label.fork-chat",
  "key.desc.fork-chat",
]

export function forkSaysBranch(tables: Tables): string[] {
  const found: string[] = []
  for (const [name, entries] of Object.entries(tables)) {
    const word = GIT_BRANCH[name]
    if (!word) {
      found.push(`${name} has no git-branch word to check against`)
      continue
    }
    for (const key of FORK_KEYS) {
      const value = entries[key]
      if (value === undefined) found.push(`${name} ${key} (missing)`)
      else if (word.test(value)) found.push(`${name} ${key} (${value})`)
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

  section("Round 8 (W5): forking a conversation never borrows the git branch's word")
  {
    const clashes = forkSaysBranch(tables)
    check("no fork string in any table uses that table's word for a git branch", clashes.length === 0, clashes.slice(0, 8))
    check("and each table's git branch label does use it, so the words checked are the real ones", Object.keys(tables).every((name) => GIT_BRANCH[name]?.test(tables[name]["home.branchLabel"] ?? "") || GIT_BRANCH[name]?.test(tables[name]["info.branchSwitchFailed"] ?? "")))
    const broken = clone(tables)
    broken.zhCN["stream.replyFork"] = "分支"
    broken.es["stream.forkFailed"] = "No se pudo crear la rama, inténtalo de nuevo"
    const caught = forkSaysBranch(broken)
    check(
      "the rule catches 分支 on the reply row and a Spanish rama",
      caught.some((line) => line.startsWith("zhCN stream.replyFork")) && caught.some((line) => line.startsWith("es stream.forkFailed")),
      caught,
    )
  }
}
