import type { HighlighterCore } from "shiki/core"

/*
 * Syntax colours, the way MiMo draws them: shiki on its JavaScript engine,
 * GitHub's light and dark themes carried side by side (the stylesheet picks
 * the dark ones under a dark theme), and the same short list of languages -
 * the ones a coding conversation is actually made of - loaded on first use.
 *
 * Nothing here blocks a render. A block is drawn plain first and coloured once
 * the highlighter answers; the answer is cached, so a block drawn again (a
 * reply still streaming re-renders every block above the one being written)
 * comes back coloured at once.
 */

/* MiMo's names and aliases, onto the grammar each one loads. */
const ALIASES: Record<string, string> = {
  ts: "typescript", typescript: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", javascript: "javascript", node: "javascript", nodejs: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "json", json5: "json",
  py: "python", python: "python", python3: "python",
  sh: "bash", bash: "bash", shell: "bash", shellscript: "bash", zsh: "bash", console: "bash",
  html: "html", htm: "html", xml: "html",
  css: "css",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  java: "java",
  sql: "sql",
  yaml: "yaml", yml: "yaml",
  c: "c", h: "c", "c#": "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cuda: "cpp", "objective-c": "cpp", objc: "cpp",
  diff: "diff", patch: "diff",
  md: "markdown", markdown: "markdown",
  vue: "vue",
}

export function languageOf(name: string | null | undefined): string | undefined {
  return name ? ALIASES[name.trim().toLowerCase()] : undefined
}

/* A file's language, from its extension. */
export function languageForFile(path: string | undefined): string | undefined {
  const extension = path?.split(".").pop()
  return extension && extension !== path ? languageOf(extension) : undefined
}

let loading: Promise<HighlighterCore> | undefined

function highlighter(): Promise<HighlighterCore> {
  loading ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([core, engine]) =>
    core.createHighlighterCore({
      themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
      langs: [
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/javascript"),
        import("@shikijs/langs/jsx"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/python"),
        import("@shikijs/langs/bash"),
        import("@shikijs/langs/html"),
        import("@shikijs/langs/css"),
        import("@shikijs/langs/go"),
        import("@shikijs/langs/rust"),
        import("@shikijs/langs/java"),
        import("@shikijs/langs/sql"),
        import("@shikijs/langs/yaml"),
        import("@shikijs/langs/c"),
        import("@shikijs/langs/cpp"),
        import("@shikijs/langs/diff"),
        import("@shikijs/langs/markdown"),
        import("@shikijs/langs/vue"),
      ],
      engine: engine.createJavaScriptRegexEngine(),
    }),
  )
  return loading
}

/* Past this a file is shown plain: colouring it would cost more than reading it. */
const LIMIT = 200_000
const CACHE_SIZE = 400
const cache = new Map<string, string>()

/** One key for both lookups: the language, a NUL that no id contains, then the source. */
function keyOf(id: string, code: string): string {
  return `${id}\u0000${code}`
}

function remember(key: string, value: string) {
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  cache.set(key, value)
}

/**
 * What the cache holds for this key, moved back to the young end.
 *
 * A Map drops in insertion order, so without the move a block asked for over
 * and over still ages out on when it was first seen: the cache kept its four
 * hundred by age rather than by use, and a block the reader keeps coming back
 * to was coloured again after every scroll past it.
 */
function recall(key: string): string | undefined {
  const known = cache.get(key)
  if (known === undefined) return undefined
  cache.delete(key)
  cache.set(key, known)
  return known
}

/** The coloured inside of a `<code>` for this source, or nothing when it cannot be coloured. */
export async function highlight(code: string, lang: string | null | undefined): Promise<string | undefined> {
  const id = languageOf(lang)
  if (!id || !code || code.length > LIMIT) return undefined
  const key = keyOf(id, code)
  const known = recall(key)
  if (known !== undefined) return known
  try {
    const html = (await highlighter()).codeToHtml(code, { lang: id, themes: { light: "github-light", dark: "github-dark" } })
    const start = html.indexOf("<code>")
    const end = html.lastIndexOf("</code>")
    if (start < 0 || end < start) return undefined
    const inner = html.slice(start + "<code>".length, end)
    remember(key, inner)
    return inner
  } catch {
    return undefined
  }
}

/**
 * The coloured inside already in the cache, without waiting: a reply drawn
 * every frame puts colour into its markup before it is bound, so a block never
 * flashes plain between one frame and the next. A hit counts as recent use.
 */
export function cachedHighlight(code: string, lang: string | null | undefined): string | undefined {
  const id = languageOf(lang)
  if (!id || !code || code.length > LIMIT) return undefined
  const key = keyOf(id, code)
  return recall(key)
}

/** The same source, coloured, one entry per line. */
export async function highlightLines(code: string, lang: string | null | undefined): Promise<string[] | undefined> {
  const inner = await highlight(code, lang)
  if (inner === undefined) return undefined
  const holder = document.createElement("div")
  holder.innerHTML = inner
  return [...holder.querySelectorAll<HTMLElement>(":scope > .line")].map((line) => line.innerHTML)
}

/**
 * Colours every rendered code block under `root` - the markdown renderer's
 * `pre.md-code` carrying its fence's language. A block already coloured for
 * the text it holds is left alone, so calling this after every render is cheap.
 */
export async function highlightWithin(root: HTMLElement | null | undefined): Promise<void> {
  if (!root) return
  for (const code of root.querySelectorAll<HTMLElement>("pre.md-code[data-lang] > code")) {
    const pre = code.parentElement as HTMLElement
    const text = code.textContent ?? ""
    const stamp = `${pre.dataset.lang}:${text.length}:${text.slice(0, 32)}`
    if (pre.dataset.highlighted === stamp) continue
    const html = await highlight(text, pre.dataset.lang)
    if (html === undefined || !code.isConnected || code.textContent !== text) continue
    code.innerHTML = html
    pre.classList.add("shiki")
    pre.dataset.highlighted = stamp
  }
}
