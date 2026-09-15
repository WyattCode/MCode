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
import { detectPath, renderMarkdown, renderReply, type MarkdownOptions } from "../src/renderer/src/lib/markdown"
import { isSvgFile, stripSvgHazards, svgSize } from "../src/renderer/src/lib/svg-safe"
import { fadeTail, type FadeAnchor } from "../src/renderer/src/lib/stream-reveal"

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
      links: { imageTip: "Preview" },
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
      if (key === "src" && !/^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|avif|bmp);)/i.test(value)) problems.push(`${name}: a picture from ${value}`)
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
]
for (const [name, source, hazard] of SVG_CASES) {
  if (hazard.test(stripSvgHazards(source))) problems.push(`the svg pre-pass let through ${name}`)
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
  ["a picture", "![a cat](https://example.com/cat.png)", /<img class="md-img" src="https:\/\/example\.com\/cat\.png" alt="a cat"/, REPLY],
  ["a picture link", "[cat](https://example.com/cat.png)", /<img class="md-img md-img-link" [^>]*data-fallback-href="https:\/\/example\.com\/cat\.png"/, REPLY],
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

/* The fade tail: which characters it wraps, at what opacity, and that it only ever adds a span with an opacity. */
const fadeCases: [string, string, number[], string][] = [
  ["the newest characters fade, oldest first", '<p class="md-p">hello</p>', [0.5, 0.2], '<p class="md-p">hel<span class="sm-fade" style="opacity:0.500">l</span><span class="sm-fade" style="opacity:0.200">o</span></p>'],
  ["code is left alone", '<p class="md-p">ab <code>xyz</code></p>', [0.1, 0.2, 0.3], '<p class="md-p"><span class="sm-fade" style="opacity:0.100">a</span><span class="sm-fade" style="opacity:0.200">b</span><span class="sm-fade" style="opacity:0.300"> </span><code>xyz</code></p>'],
  ["an entity is one character", '<p class="md-p">a&amp;</p>', [0.25], '<p class="md-p">a<span class="sm-fade" style="opacity:0.250">&amp;</span></p>'],
  ["a fully bright character stays plain", '<p class="md-p">ab</p>', [1, 0.5], '<p class="md-p">a<span class="sm-fade" style="opacity:0.500">b</span></p>'],
  ["the code block's own words are not typed text", '<div class="md-codeblock"><span class="md-code-lang">js</span></div><p class="md-p">q</p>', [0.4], '<div class="md-codeblock"><span class="md-code-lang">js</span></div><p class="md-p"><span class="sm-fade" style="opacity:0.400">q</span></p>'],
  ["fewer characters than stamps take the newest", '<p class="md-p">ab</p>', [0.1, 0.2, 0.3], '<p class="md-p"><span class="sm-fade" style="opacity:0.200">a</span><span class="sm-fade" style="opacity:0.300">b</span></p>'],
]
for (const [name, html, opacities, want] of fadeCases) {
  const got = fadeTail(html, opacities)
  if (got !== want) problems.push(`fade: ${name}: ${got}`)
  inspect(`fade: ${name}`, got)
}
const fadeAnchor: FadeAnchor = { start: 0, floors: [] }
fadeTail('<p class="md-p">ab</p>', [0.6, 0.7], fadeAnchor)
const brightened = fadeTail('<p class="md-p">ab</p>', [0.1, 0.2], fadeAnchor)
if (brightened !== '<p class="md-p"><span class="sm-fade" style="opacity:0.600">a</span><span class="sm-fade" style="opacity:0.700">b</span></p>') {
  problems.push(`fade: a character dimmed again after brightening: ${brightened}`)
}
for (const item of HOSTILE) inspect(`${item.name} (live, faded)`, fadeTail(liveHtml(item.source), [0.1, 0.2, 0.3, 0.4]))

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

console.log(`live cases: ${liveCases.length + 1}, fade cases: ${fadeCases.length + 1 + HOSTILE.length}, svg card cases: ${SVG_FILES.length + 6}`)
console.log(`hostile inputs: ${HOSTILE.length} x ${OPTIONS.length + 1} option sets, svg pre-pass cases: ${SVG_CASES.length}, formatting cases: ${shape.length + blockCases.length + PATHS.length}`)

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("Nothing a model writes becomes markup, and the formatting still works.")
