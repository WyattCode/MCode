/**
 * Round 17, lane V: the file tab and the document viewers.
 *
 * Three kinds of check. Some of this is arithmetic and runs against the real
 * code: the tree's scored search over a tree made here, the files tab's answer
 * for a PDF past the byte limit, the Word text extraction that an empty run
 * used to derail, and the patterns a step row's path is read by, lifted out of
 * the module and run. The rest lives in markup and stylesheets - the shared
 * markdown body, the find bar's field, the PDF's content block, the
 * spreadsheet's restore - and is read from the source here; the geometry and
 * the rendering behind those are measured in the lane's Electron probes
 * (v17-probe.cjs, v17-probe2.cjs, v17-probe3.cjs), whose numbers are in the
 * report.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { searchTree, readPreview, MEDIA_LIMIT } from "../src/server/handlers"
import { paragraphTexts, parseComments } from "../src/renderer/src/lib/docx-parse"
import { collapse } from "../src/shared/annotations"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A two-page PDF, optionally with an unused object of `pad` bytes so the file passes a size. */
function pdfBytes(pad: number): Buffer {
  const objects: string[] = []
  const streams = ["BT /F1 24 Tf 72 700 Td (page one) Tj ET", "BT /F1 24 Tf 72 700 Td (page two) Tj ET"]
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>"
  objects[4] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"
  objects[5] = `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`
  objects[6] = `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`
  objects[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  if (pad > 0) objects[8] = `<< /Length ${pad} >>\nstream\n${"0".repeat(pad)}\nendstream`
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let at = 1; at < objects.length; at++) {
    offsets[at] = out.length
    out += `${at} 0 obj\n${objects[at]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let at = 1; at < objects.length; at++) out += `${String(offsets[at]).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** One regular expression declared in a module, by the name it is bound to, ready to run. */
function patternOf(source: string, name: string): RegExp | undefined {
  const found = new RegExp(`\\bconst ${name} =\\s*(/(?:[^/\\\\\\n]|\\\\.)+/[a-z]*)`).exec(source)
  if (!found) return undefined
  const cut = found[1].lastIndexOf("/")
  try {
    return new RegExp(found[1].slice(1, cut), found[1].slice(cut + 1))
  } catch {
    return undefined
  }
}

export async function roundSeventeenViewerChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 17 (lane V): R17-V1 the file tab draws markdown the way a reply is drawn")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    const body = await read("src/renderer/src/components/parts/MarkdownBody.vue")
    const part = await read("src/renderer/src/components/parts/TextPart.vue")
    check("R17-V1: the file tab hangs the shared body on a .md file", /<MarkdownBody\s+:text="opened\.content"/.test(files))
    check("R17-V1: and no longer binds markup of its own", !files.includes("renderMarkdown"))
    check("R17-V1: a reply is the same body", /<MarkdownBody\s+:text="text"\s+:live="live"/.test(part) && part.includes('import MarkdownBody from "./MarkdownBody.vue"'))
    for (const option of ["math: true", "codeActions:", "tableActions:", "links: {", "paths: {", "diagrams: {", "lineNumbers: true"]) {
      check(`R17-V1: the body asks the renderer for ${option.replace(/[:{ ].*$/, "")}`, body.includes(option))
    }
    for (const blockKind of ["DiagramBlock", "AbcBlock", "WidgetBlock", "LocalMedia"]) {
      check(`R17-V1: and mounts ${blockKind}, which markup alone cannot carry`, body.includes(`import ${blockKind} from`))
    }
    check("R17-V1: the files tab is not an annotatable reply", !/data-annotate="answer"/.test(files))
    check("R17-V1: the body takes the attributes its host gives it", body.includes("defineOptions({ inheritAttrs: false })") && body.includes('v-bind="$attrs"'))
  }

  section("Round 17 (lane V): R17-V2 the find bar's field keeps its 150px")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    const field = /\.fv-find-input \{[\s\S]*?\}/.exec(files)?.[0] ?? ""
    check("R17-V2: the field is a fixed 150 and does not flex", /flex:\s*none/.test(field) && /width:\s*150px/.test(field))
    check("R17-V2: it has no floor of zero left on it", !/min-width:\s*0/.test(field))
    const bar = /\.fv-find \{[\s\S]*?\}/.exec(files)?.[0] ?? ""
    check("R17-V2: and the bar's own floor counts the field", /min-width:\s*calc\([^)]*150px/.test(bar))
  }

  section("Round 17 (lane V): R17-V3 the tree's search is scored on the whole path")
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r17v-tree-"))
    try {
      await fs.mkdir(path.join(root, "src", "right"), { recursive: true })
      await fs.mkdir(path.join(root, "src", "left"), { recursive: true })
      await fs.mkdir(path.join(root, "deep", "a", "b"), { recursive: true })
      await fs.writeFile(path.join(root, "src", "right", "RpFiles.vue"), "x")
      await fs.writeFile(path.join(root, "src", "left", "RpFiles.vue"), "x")
      await fs.writeFile(path.join(root, "RpFiles.vue"), "x")
      await fs.writeFile(path.join(root, "deep", "a", "b", "notes.md"), "x")
      const rels = (found: { entries: { rel: string }[] }) => found.entries.map((entry) => entry.rel)

      const slash = await searchTree(root, "src/right/RpFiles")
      check("R17-V3: a path-shaped query finds the file it names", rels(slash).includes("src/right/RpFiles.vue"), rels(slash))
      check("R17-V3: and it comes first", rels(slash)[0] === "src/right/RpFiles.vue", rels(slash))
      const wrong = await searchTree(root, "src/left/RpFiles")
      check("R17-V3: the other folder's copy wins its own query", rels(wrong)[0] === "src/left/RpFiles.vue", rels(wrong))

      const named = await searchTree(root, "rpfiles")
      check("R17-V3: a plain query still finds every match", named.entries.length === 3, rels(named))
      check("R17-V3: the shortest path is preferred among equal names", rels(named)[0] === "RpFiles.vue", rels(named))
      const none = await searchTree(root, "nothing-here")
      check("R17-V3: a query that matches nothing says so plainly", none.entries.length === 0 && !none.truncated)

      // Fifty-one files with the same name: the answer is cut to fifty and says it was.
      await fs.mkdir(path.join(root, "many"), { recursive: true })
      for (let at = 0; at < 51; at++) await fs.writeFile(path.join(root, "many", `widget${at}.ts`), "x")
      const many = await searchTree(root, "widget")
      check("R17-V3: fifty is the most that comes back", many.entries.length === 50, many.entries.length)
      check("R17-V3: and more than fifty is reported as cut", many.truncated)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  section("Round 17 (lane V): R17-V4 a PDF is streamed, with no ceiling on it")
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r17v-pdf-"))
    try {
      const big = path.join(root, "scan.pdf")
      await fs.writeFile(big, pdfBytes(26 * 1024 * 1024))
      const size = (await fs.stat(big)).size
      check("R17-V4: the test document is past the byte limit", size > MEDIA_LIMIT, size)
      const shown = await readPreview(big)
      check("R17-V4: the files tab shows it as a PDF", shown.kind === "pdf", shown.kind)
      check("R17-V4: and does not call it too large", !shown.tooBig)

      const picture = path.join(root, "big.png")
      await fs.writeFile(picture, Buffer.alloc(MEDIA_LIMIT + 1))
      const refused = await readPreview(picture)
      check("R17-V4: a picture that big is still refused, since it is read whole", refused.tooBig === true)

      const view = await read("src/renderer/src/components/right/PdfView.vue")
      check("R17-V4: the view asks the preview server for the document", /officeServe\(props\.path\)/.test(view))
      check("R17-V4: and hands pdf.js its address rather than its bytes", /getDocument\(\{\s*\n?\s*url: served\.url/.test(view))
      check("R17-V4: nothing decodes the whole file into an array any more", !view.includes("atob(read.base64)"))
      const server = await read("src/main/preview-server.ts")
      check("R17-V4: the server lets the window read a PDF across origins", /extension === "\.svg" \|\| extension === "\.pdf"/.test(server))
      check("R17-V4: and shows it the range headers", /Access-Control-Expose-Headers[^\n]*Content-Range/.test(server))
      check("R17-V4: ranges are answered as ranges", server.includes('"Accept-Ranges": "bytes"') && server.includes("206"))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  section("Round 17 (lane V): R17-V5 a file opened from anywhere names its tab")
  {
    const open = await read("src/renderer/src/lib/office-open.ts")
    const inside = /if \(full\.toLowerCase\(\)\.startsWith\(base\.toLowerCase\(\)\)\) \{[\s\S]*?\n {4}\}/.exec(open)?.[0] ?? ""
    check("R17-V5: a file inside the project names its tab", /name: nameOf\(rel\)/.test(inside), inside.slice(0, 200))
    check("R17-V5: and keeps the project as the tree's root", /fileRoot: undefined/.test(inside))
    const outside = /const cut = full\.lastIndexOf\("\/"\)[\s\S]*?revealPath/.exec(open)?.[0] ?? ""
    check("R17-V5: a file outside it names its tab too", /name: nameOf\(full\)/.test(outside))
    check("R17-V5: and moves the tree to the file's own folder", /fileRoot:/.test(outside))
    check("R17-V5: a drive root keeps its separator", /\/\^\[a-zA-Z\]:\$\/\.test\(folder\)/.test(outside))
    check("R17-V5: the posix root is a folder as well", /cut === 0 \? "\/"/.test(outside))
    check("R17-V5: only a bare name is left to the system", /cut >= 0/.test(outside))
    check("R17-V5: the user's choice about the two roots is written down", /user's choice of\s+(\*\s+)?2026-09-21/.test(open))
  }

  section("Round 17 (lane V): R17-V6 a step row's path is read by MiMo's patterns")
  {
    const step = await read("src/renderer/src/lib/open-step-path.ts")
    const text = patternOf(step, "TEXT")
    const code = patternOf(step, "CODE")
    const image = patternOf(step, "IMAGE")
    const html = patternOf(step, "HTML")
    const abc = patternOf(step, "ABC")
    check("R17-V6: the four patterns and the score's are there to run", Boolean(text && code && image && html && abc))
    if (text && code && image && html && abc) {
      const opens = (name: string) => text.test(name) || abc.test(name) || code.test(name) || image.test(name)
      for (const name of ["notes.mdx", "readme.rst", "todo.org", "paper.tex", "guide.adoc", "spec.jsonc", "run.pyw", "core.cljs", "build.groovy", "app.nim", "app.properties", "tune.abc"]) {
        check(`R17-V6: ${name} opens in the panel, as it does in MiMo`, opens(name), name)
      }
      for (const name of [".gitignore", ".gitattributes", ".editorconfig"]) {
        check(`R17-V6: ${name}, which is all suffix, is matched at last`, opens(name), name)
      }
      for (const name of ["notes.ml", "main.tf", "shell.nix", "rows.jsonl", "Makefile", "Dockerfile"]) {
        check(`R17-V6: ${name} is located in the file manager, as MiMo locates it`, !opens(name) && !html.test(name), name)
      }
      check("R17-V6: a query after the suffix is allowed", opens("readme.md?v=2") && html.test("index.html#top"))
      check("R17-V6: a page is a page", html.test("index.htm") && html.test("INDEX.HTML"))
      check("R17-V6: a document is not", !html.test("report.docx") && !opens("report.docx"))
    }
    check("R17-V6: a page outside the project goes to the desktop too", step.includes("openNativePath(absolute)"))
    check("R17-V6: and no set of suffixes is left", !/new Set\(\[/.test(step))
  }

  section("Round 17 (lane V): R17-V7 the spreadsheet stops restoring once the reader moves")
  {
    const sheet = await read("src/renderer/src/components/right/XlsxView.vue")
    const restore = /function restoreView\([\s\S]*?\n\}/.exec(sheet)?.[0] ?? ""
    check("R17-V7: each try remembers the scroll state it produced", /ours = \{ row, col \}/.test(restore))
    check("R17-V7: and the next one gives up when that is no longer what is on screen", /sheetViewStartRow !== ours\.row \|\| now\.sheetViewStartColumn !== ours\.col/.test(restore))
    check("R17-V7: giving up means giving up", /done = true\s*\n\s*return/.test(restore))
    check("R17-V7: a view at the first cell is not restored at all", /if \(view\.row <= 0 && view\.col <= 0\) return/.test(restore))
    check("R17-V7: the sheet changing still calls it off", restore.includes("getSheetName() !== view.sheetName"))
  }

  section("Round 17 (lane V): R17-V8 Word text survives an empty run, and a comment id is escaped")
  {
    const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`
    const paragraph = `<w:p>${run("one")}<w:r><w:t/></w:r>${run("two")}</w:p>`
    check("R17-V8: an empty run is skipped rather than swallowing what follows", paragraphTexts(paragraph).join("|") === "onetwo", paragraphTexts(paragraph))
    const spaced = `<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r>${run("b")}</w:p>`
    check("R17-V8: a run with attributes still reads", paragraphTexts(spaced).join("|") === "a b", paragraphTexts(spaced))

    const id = "c.1"
    const commentsXml = `<w:comments><w:comment w:id="${id}" w:author="A" w:date="d"><w:p>${run("note")}</w:p></w:comment></w:comments>`
    const documentXml = `<w:p><w:commentRangeStart w:id="${id}"/>${run("marked")}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`
    const found = parseComments(commentsXml, documentXml)
    check("R17-V8: a comment whose id is not a number is still read", found.length === 1 && found[0].text === "note", found)
    check("R17-V8: and its marked range with it", found[0]?.rangeText === "marked", found[0]?.rangeText)
    const parse = await read("src/renderer/src/lib/docx-parse.ts")
    check("R17-V8: the id is escaped before it stands in a pattern", parse.includes("const id = escapeRegExp(comment.id)"))
    check("R17-V8: the text pattern pins its attributes and lets no tag in", parse.includes("(?:\\\\s[^>]*)?>([^<]*)<"))
    const docx = await read("src/renderer/src/components/right/DocxView.vue")
    check("R17-V8: and before it stands in a selector", docx.includes("CSS.escape(comment.id)"))
  }

  section("Round 17 (lane V): R17-V9 to R17-V14, the rest of the lane")
  {
    const pdf = await read("src/renderer/src/components/right/PdfView.vue")
    check("R17-V9: the PDF's scroller is a content block", /class="office-sel" data-selectable="content" data-pdf-scroll/.test(pdf))
    const docx = await read("src/renderer/src/components/right/DocxView.vue")
    const pptx = await read("src/renderer/src/components/right/PptxView.vue")
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    check("R17-V9: as every other document view's is", [docx, pptx, files].every((source) => source.includes('data-selectable="content"')))

    check("R17-V10: a PDF quotation is folded", pdf.includes("const folded = collapse(selectedText)"))
    check("R17-V10: and a cut one ends in an ellipsis", /folded\.length > 400 \? `\$\{folded\.slice\(0, 400\)\}…`/.test(pdf))
    check("R17-V10: which is what the other two views do", docx.includes("folded.slice(0, 400)") && pptx.includes("folded.slice(0, 400)"))
    const long = collapse(`${"a\nb ".repeat(300)}`)
    check("R17-V10: folding leaves no newline behind", !long.includes("\n") && long.length > 400)

    check("R17-V11: a load calls off the last one's restore loop", /async function load\(\) \{[\s\S]{0,260}stopRestore\?\.\(\)/.test(pdf))
    check("R17-V11: and forgets it, so it is not called twice", /stopRestore\?\.\(\)\s*\n\s*stopRestore = undefined/.test(pdf))

    const abc = await read("src/renderer/src/lib/abc.ts")
    check("R17-V13: the drawn score is put back in the flow", /drawn\.style\.position = "static"/.test(abc))
    check("R17-V13: with the offsets abcjs left on it cleared", /drawn\.style\.top = ""/.test(abc) && /drawn\.style\.left = ""/.test(abc))

    check("R17-V14: pressing the open row reads the file again", /if \(rel === props\.viewFile && !editing\.value\) void readFile\(rel, true\)/.test(files))
    check("R17-V14: a score offers no edit button", /const isText = computed\([^\n]*!isAbc\.value\)/.test(files))
  }
}
