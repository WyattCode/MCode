/**
 * Checks that nothing a model writes can become markup.
 *
 * The renderer escapes its source and then applies formatting to the escaped
 * text, which is the whole security argument for having written one instead of
 * reaching for a parser plus a sanitizer. That argument is only as good as the
 * ordering, and the ordering is easy to break by adding a rule that emits an
 * attribute - so it is worth asserting rather than commenting.
 *
 * This matters more than it used to: the shared HTML export runs assistant text
 * through the same function, and that file is opened directly in a browser,
 * outside the app's own CSP.
 *
 * The test is not "does the output contain a scary word". Escaped text contains
 * scary words - `&lt;img src=x onerror=alert(1)&gt;` is inert, and reading it as
 * a finding is how the first version of this check produced four false alarms.
 * What matters is which tags and attributes the renderer actually emitted, so
 * that is what is inspected.
 */
import { renderMarkdown } from "../src/renderer/src/lib/markdown"

/** Everything the renderer is allowed to produce. Anything else came from the source. */
const TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "code", "pre", "ul", "ol", "li",
  "blockquote", "span", "table", "thead", "tbody", "tr", "th", "td", "hr",
])
const ATTRIBUTES = new Set(["class", "data-level", "data-language"])

const OPEN_TAG = /<\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const CLOSE_TAG = /<\s*\/\s*([a-zA-Z][\w-]*)\s*>/g
const ATTRIBUTE = /([a-zA-Z-]+)\s*=/g

const HOSTILE: { name: string; source: string }[] = [
  { name: "a script tag", source: "<script>alert(1)</script>" },
  { name: "an image with an error handler", source: '<img src=x onerror="alert(1)">' },
  { name: "a script tag inside a fenced block", source: "```\n<script>alert(1)</script>\n```" },
  { name: "a script tag inside inline code", source: "`<script>alert(1)</script>`" },
  { name: "markup inside a heading", source: "# <script>alert(1)</script>" },
  { name: "markup inside a list item", source: "- <img src=x onerror=alert(1)>" },
  { name: "markup inside a blockquote", source: "> <script>alert(1)</script>" },
  { name: "markup inside bold", source: "**<script>alert(1)</script>**" },
  { name: "a javascript: link", source: "[click](javascript:alert(1))" },
  { name: "a quote breaking out of an attribute", source: '[x](" onmouseover="alert(1))' },
  { name: "a fence language carrying an attribute", source: '```js" onload="alert(1)\ncode\n```' },
  { name: "a fence language carrying a tag", source: "```<script>\ncode\n```" },
  { name: "an unclosed tag", source: "<div" },
  { name: "an entity that should stay literal", source: "&lt;script&gt;" },
  { name: "a table cell with markup", source: "| a |\n| - |\n| <b>x</b> |" },
  { name: "a link whose text is markup", source: "[<img src=x onerror=alert(1)>](https://example.com)" },
]

const problems: string[] = []

for (const item of HOSTILE) {
  const html = renderMarkdown(item.source)

  for (const match of html.matchAll(OPEN_TAG)) {
    const [, tag, rest] = match
    if (!TAGS.has(tag.toLowerCase())) {
      problems.push(`${item.name}: emitted <${tag}>`)
    }
    for (const attribute of rest.matchAll(ATTRIBUTE)) {
      if (!ATTRIBUTES.has(attribute[1].toLowerCase())) {
        problems.push(`${item.name}: emitted the attribute ${attribute[1]}= on <${tag}>`)
      }
    }
  }
  for (const match of html.matchAll(CLOSE_TAG)) {
    if (!TAGS.has(match[1].toLowerCase())) {
      problems.push(`${item.name}: emitted </${match[1]}>`)
    }
  }
}

/*
 * The formatting still has to work, or a renderer that escaped everything and
 * emitted nothing would sail through the checks above.
 */
const NEWLINE = String.fromCharCode(10)
const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join(NEWLINE)
const ALIGNED = ["| l | r |", "| :-- | --: |", "| 1 | 2 |"].join(NEWLINE)

const shape: [string, string, RegExp][] = [
  ["a heading", "## Title", /data-level="2"[^>]*>Title</],
  ["bold", "**loud**", /<strong>loud<\/strong>/],
  ["inline code", "`x = 1`", /<code>x = 1<\/code>/],
  ["a fenced block", "```\nx\n```", /<pre/],
  ["a bullet list", "- one\n- two", /<li[^>]*>one<\/li>/],
  ["a link's text and url", "[text](https://example.com)", /text.*example\.com/],
  /*
   * Tables. The allowlist above already permitted these tags, so nothing here
   * failed while the renderer emitted none of them - a reply containing a table
   * arrived as three lines of raw pipes and every check passed.
   */
  ["a table's head", TABLE, /<table class="md-table">[\s\S]*<th>a<\/th>/],
  ["a table's body", TABLE, /<td>1<\/td><td>2<\/td>/],
  ["a column the delimiter aligned", ALIGNED, /<th class="md-right">r<\/th>/],
  // The negative case, which matters more here than the positive ones: a shell
  // pipe is far commoner in this app than a table and must stay prose.
  ["a piped command is not a table", "run `ls | grep x` to see", /^<p class="md-p">run <code>/],
  ["and a rule is still a rule", ["text", "", "---", "", "more"].join(NEWLINE), /<hr class="md-rule"/],
]

for (const [name, source, expected] of shape) {
  const html = renderMarkdown(source)
  if (!expected.test(html)) {
    problems.push(`${name} no longer renders: ${html.slice(0, 120)}`)
  }
}

console.log(`hostile inputs: ${HOSTILE.length}, formatting cases: ${shape.length}`)

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("Nothing a model writes becomes markup, and the formatting still works.")
