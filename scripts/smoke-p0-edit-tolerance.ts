/**
 * Focused checks for P0-1: edit tolerates small quoting mistakes when the
 * match is unique, says when it did, refuses ambiguous fuzzy matches, refuses
 * stale reads/writes, and refuses edits to existing files that were never read.
 *
 * Each scenario gets a fresh session so tool-recorded write stamps do not make
 * the next scenario's setup look like an external edit. The stale scenarios
 * intentionally share one session.
 *
 * Run on its own: `npx tsx scripts/smoke-p0-edit-tolerance.ts`.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EditTool, WriteTool } from "../src/server/tool/edit"
import { recordRead } from "../src/server/tool/read-tracker"

process.env.MCODE_POST_EDIT_CHECK = "0"

let passed = 0
let failed = 0
let currentScenario = "startup"

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function failUnexpected(name: string, error: unknown) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  console.log(`  FAIL ${name} -> unexpected exception: ${message}`)
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-p0-edit-"))
}

function context(directory: string, sessionID: string, ask?: () => Promise<void> | void): any {
  return {
    sessionID,
    messageID: "m1",
    callID: "c1",
    directory,
    permissions: {
      ask: async () => {
        if (ask) await ask()
      },
    },
    questions: {},
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    plan: undefined,
    agent: "build",
  }
}

async function markRead(ctx: any, filePath: string): Promise<void> {
  const stat = await fs.stat(filePath)
  const content = await fs.readFile(filePath, "utf8")
  recordRead(ctx.sessionID, filePath, { mtimeMs: stat.mtimeMs, size: stat.size }, content)
}

async function main(): Promise<void> {
  try {
    const root = await tempDir()
    const file = path.join(root, "a.js")
    let sessionCounter = 0
    const freshContext = () => context(root, `s${++sessionCounter}`)

    async function run(name: string, fn: (ctx: any) => Promise<void>, ctx?: any): Promise<void> {
      currentScenario = name
      try {
        await fn(ctx ?? freshContext())
      } catch (error) {
        failUnexpected(name, error)
      }
    }

    // exact edit unchanged
    await run("exact edit unchanged", async (ctx) => {
      await fs.writeFile(file, "const x = 1\n", "utf8")
      await markRead(ctx, file)
      const exact = await EditTool.execute({ file_path: "a.js", old_string: "const x = 1", new_string: "const x = 2" }, ctx)
      check("exact edit unchanged", (await fs.readFile(file, "utf8")) === "const x = 2\n" && exact.output === "Edited a.js", exact)
    })

    // tab-vs-space / indent-shifted quote applied once with re-indented new_string
    await run("indentation tier", async (ctx) => {
      await fs.writeFile(file, "function f() {\n\treturn 1\n}\n", "utf8")
      await markRead(ctx, file)
      const indent = await EditTool.execute({ file_path: "a.js", old_string: "  return 1", new_string: "  return 2" }, ctx)
      check("indentation tier applied", (await fs.readFile(file, "utf8")) === "function f() {\n\treturn 2\n}\n", indent)
      check("indentation tier says so", /matched lines 2-2 after ignoring indentation differences; new_string re-indented/.test(indent.output), indent.output)
      check("indentation tier metadata", indent.metadata?.matchTier === "indentation", indent.metadata)
    })

    // indentation tier must not add blockIndent to new_string lines that do not
    // start with the quote's common indentation prefix
    await run("indentation no over-indent", async (ctx) => {
      await fs.writeFile(file, "function f() {\n\tif ( Cond ) {\n\t\treturn 1\n\t}\n}\n", "utf8")
      await markRead(ctx, file)
      const noOver = await EditTool.execute({
        file_path: "a.js",
        old_string: "  if ( Cond ) {\n  \treturn 1\n  }",
        new_string: "  if ( Cond ) {\n\t\treturn 2\n  }",
      }, ctx)
      const content = await fs.readFile(file, "utf8")
      check("indentation no over-indent applied", content === "function f() {\n\tif ( Cond ) {\n\t\treturn 2\n\t}\n}\n", JSON.stringify(content))
      check("indentation no over-indent says so", /matched lines 2-4 after ignoring indentation differences; new_string re-indented/.test(noOver.output), noOver.output)
      check("indentation no over-indent metadata", noOver.metadata?.matchTier === "indentation", noOver.metadata)
      check("indentation no over-indent no extra block indent", !content.includes("\t\t\t") && !content.includes("\t  return") && !content.includes("  \treturn"), JSON.stringify(content))
    })

    // curly-quote quote matched against ASCII
    await run("curly quote tier", async (ctx) => {
      await fs.writeFile(file, "const s = 'hello'\n", "utf8")
      await markRead(ctx, file)
      const curly = await EditTool.execute({ file_path: "a.js", old_string: "const s = ‘hello’", new_string: "const s = \"hello\"" }, ctx)
      check("curly quote matched against ASCII", (await fs.readFile(file, "utf8")) === "const s = \"hello\"\n", curly)
      check("unicode tier says so", /matched lines 1-1 after ignoring typographic quotes and unicode spaces/.test(curly.output), curly.output)
      check("unicode tier metadata", curly.metadata?.matchTier === "unicode", curly.metadata)
    })

    // ASCII quote matched against curly
    await run("ASCII quote matched against curly", async (ctx) => {
      await fs.writeFile(file, "const s = “hello”\n", "utf8")
      await markRead(ctx, file)
      const ascii = await EditTool.execute({ file_path: "a.js", old_string: "const s = \"hello\"", new_string: "const s = \"hi\"" }, ctx)
      check("ASCII quote matched against curly", (await fs.readFile(file, "utf8")) === "const s = \"hi\"\n", ascii)
    })

    // trailing whitespace
    await run("trailing whitespace tier", async (ctx) => {
      await fs.writeFile(file, "a()   \nb()\n", "utf8")
      await markRead(ctx, file)
      const trailing = await EditTool.execute({ file_path: "a.js", old_string: "a()\nb()", new_string: "c()\nd()" }, ctx)
      check("trailing whitespace tier applied", (await fs.readFile(file, "utf8")) === "c()\nd()\n", trailing)
      check("trailing whitespace says so", /matched lines 1-2 after ignoring trailing whitespace/.test(trailing.output), trailing.output)
      check("trailing whitespace metadata", trailing.metadata?.matchTier === "trailing-whitespace", trailing.metadata)
    })

    // leading + trailing whitespace, with the quote itself trimmed
    await run("trim tier", async (ctx) => {
      await fs.writeFile(file, "    foo   \n    bar\t\n", "utf8")
      await markRead(ctx, file)
      const trimmed = await EditTool.execute({ file_path: "a.js", old_string: "foo\nbar", new_string: "baz\nqux" }, ctx)
      check("trim tier applied", (await fs.readFile(file, "utf8")) === "baz\nqux\n", trimmed)
      check("trim tier says so", /matched lines 1-2 after ignoring leading and trailing whitespace/.test(trimmed.output), trimmed.output)
      check("trim tier metadata", trimmed.metadata?.matchTier === "trim", trimmed.metadata)
    })

    // curly quotes plus trailing whitespace compose into the normalize tier
    await run("normalize tier", async (ctx) => {
      await fs.writeFile(file, "const s = “hello”   \n", "utf8")
      await markRead(ctx, file)
      const normalized = await EditTool.execute({ file_path: "a.js", old_string: "const s = \"hello\"", new_string: "const s = \"hi\"" }, ctx)
      check("normalize tier applied", (await fs.readFile(file, "utf8")) === "const s = \"hi\"\n", normalized)
      check("normalize tier says so", /matched lines 1-1 after ignoring typographic quotes, unicode spaces and surrounding whitespace/.test(normalized.output), normalized.output)
      check("normalize tier metadata", normalized.metadata?.matchTier === "normalize", normalized.metadata)
    })

    // unicode dash/ellipsis plus surrounding whitespace
    await run("normalize tier with unicode punctuation and trim", async (ctx) => {
      await fs.writeFile(file, "    const x = 1 — 2   \n    const y = 1…\t\n", "utf8")
      await markRead(ctx, file)
      const normalized = await EditTool.execute({
        file_path: "a.js",
        old_string: "const x = 1 - 2\nconst y = 1...",
        new_string: "const x = 1 - 3\nconst y = 1..",
      }, ctx)
      check("normalize unicode punctuation applied", (await fs.readFile(file, "utf8")) === "const x = 1 - 3\nconst y = 1..\n", normalized)
      check("normalize unicode punctuation says so", /matched lines 1-2 after ignoring typographic quotes, unicode spaces and surrounding whitespace/.test(normalized.output), normalized.output)
      check("normalize unicode punctuation metadata", normalized.metadata?.matchTier === "normalize", normalized.metadata)
    })

    // ambiguous fuzzy -> error with line numbers and file unchanged
    await run("ambiguous fuzzy", async (ctx) => {
      await fs.writeFile(file, "foo\nbar\nfoo\n", "utf8")
      await markRead(ctx, file)
      let ambiguousThrown = false
      try {
        await EditTool.execute({ file_path: "a.js", old_string: "  foo", new_string: "  baz" }, ctx)
      } catch (error) {
        ambiguousThrown = true
        const message = String((error as Error).message)
        check("ambiguous fuzzy error lists line-numbered candidates", /1: foo/.test(message) && /3: foo/.test(message), message)
      }
      check("ambiguous fuzzy throws", ambiguousThrown)
      check("ambiguous fuzzy leaves file unchanged", (await fs.readFile(file, "utf8")) === "foo\nbar\nfoo\n")
    })

    // not-found hint has line numbers, and the hint body is shown once
    await run("not-found hint", async (ctx) => {
      await fs.writeFile(file, "function go() {\n  const a = 1\n  return a\n}\n", "utf8")
      await markRead(ctx, file)
      let notFoundThrown = false
      try {
        await EditTool.execute({ file_path: "a.js", old_string: "function go() {\n  const a = 10\n  return a\n}", new_string: "function go() {\n  const a = 2\n  return a\n}" }, ctx)
      } catch (error) {
        notFoundThrown = true
        const message = String((error as Error).message)
        check("not-found hint has line numbers", /1: function go\(\) \{/.test(message) && /lines 1-4/.test(message), message)
        check("not-found hint body appears once", (message.match(/return a/g) ?? []).length === 1, message)
      }
      check("not-found throws", notFoundThrown)
    })

    // replace_all exact still works
    await run("replace_all exact", async (ctx) => {
      await fs.writeFile(file, "foo\nfoo\nfoo\n", "utf8")
      await markRead(ctx, file)
      const all = await EditTool.execute({ file_path: "a.js", old_string: "foo", new_string: "bar", replace_all: true }, ctx)
      check("replace_all exact works", (await fs.readFile(file, "utf8")) === "bar\nbar\nbar\n", all)
      check("replace_all exact output", all.output === "Edited a.js (3 occurrences)", all.output)
    })

    // stale read scenarios share one session deliberately
    const staleCtx = freshContext()

    // stale read: record read, modify file mtime/size externally, edit -> error and file unchanged
    await run("stale edit throws", async (ctx) => {
      await fs.writeFile(file, "original\n", "utf8")
      const stat = await fs.stat(file)
      recordRead(ctx.sessionID, file, { mtimeMs: stat.mtimeMs, size: stat.size }, "original\n")
      await fs.writeFile(file, "external\n", "utf8")
      let staleThrown = false
      try {
        await EditTool.execute({ file_path: "a.js", old_string: "original", new_string: "edited" }, ctx)
      } catch (error) {
        staleThrown = true
        check("stale edit message", /has changed since you last read it/.test(String((error as Error).message)), String(error))
      }
      check("stale edit throws", staleThrown)
      check("stale edit leaves file unchanged", (await fs.readFile(file, "utf8")) === "external\n")
    }, staleCtx)

    // after re-read edit works
    await run("edit works after re-read", async (ctx) => {
      const rereadStat = await fs.stat(file)
      recordRead(ctx.sessionID, file, { mtimeMs: rereadStat.mtimeMs, size: rereadStat.size }, "external\n")
      const afterReread = await EditTool.execute({ file_path: "a.js", old_string: "external", new_string: "edited" }, ctx)
      check("edit works after re-read", (await fs.readFile(file, "utf8")) === "edited\n", afterReread)
    }, staleCtx)

    // write on stale file refused
    await run("stale write throws", async (ctx) => {
      await fs.writeFile(file, "before\n", "utf8")
      const beforeStat = await fs.stat(file)
      recordRead(ctx.sessionID, file, { mtimeMs: beforeStat.mtimeMs, size: beforeStat.size }, "before\n")
      await fs.writeFile(file, "external\n", "utf8")
      let writeStaleThrown = false
      try {
        await WriteTool.execute({ file_path: "a.js", content: "written\n" }, ctx)
      } catch (error) {
        writeStaleThrown = true
        check("stale write message", /has changed since you last read it/.test(String((error as Error).message)), String(error))
      }
      check("stale write throws", writeStaleThrown)
      check("stale write leaves file unchanged", (await fs.readFile(file, "utf8")) === "external\n")
    }, staleCtx)

    // never-read existing file is not editable
    await run("never-read existing file is not editable", async (ctx) => {
      const fresh = path.join(root, "fresh.js")
      await fs.writeFile(fresh, "hello\n", "utf8")

      let editThrown = false
      try {
        await EditTool.execute({ file_path: "fresh.js", old_string: "hello", new_string: "world" }, ctx)
      } catch (error) {
        editThrown = true
        check("never-read edit message", /has not been read/.test(String((error as Error).message)), String(error))
      }
      check("never-read edit throws", editThrown)
      check("never-read edit leaves file unchanged", (await fs.readFile(fresh, "utf8")) === "hello\n")

      let writeThrown = false
      try {
        await WriteTool.execute({ file_path: "fresh.js", content: "world\n" }, ctx)
      } catch (error) {
        writeThrown = true
        check("never-read write message", /has not been read/.test(String((error as Error).message)), String(error))
      }
      check("never-read write throws", writeThrown)
      check("never-read write leaves file unchanged", (await fs.readFile(fresh, "utf8")) === "hello\n")
    })

    // read then edit ok
    await run("read then edit ok", async (ctx) => {
      const fresh = path.join(root, "read-then-edit.js")
      await fs.writeFile(fresh, "hello\n", "utf8")
      await markRead(ctx, fresh)
      const edited = await EditTool.execute({ file_path: "read-then-edit.js", old_string: "hello", new_string: "world" }, ctx)
      check("read then edit ok", (await fs.readFile(fresh, "utf8")) === "world\n", edited)
    })

    // write new file without read ok
    await run("write new file without read ok", async (ctx) => {
      const fresh = path.join(root, "new-write.js")
      await fs.rm(fresh, { force: true })
      const written = await WriteTool.execute({ file_path: "new-write.js", content: "hello\n" }, ctx)
      check("write new file without read ok", (await fs.readFile(fresh, "utf8")) === "hello\n", written)
    })

    // edit: file changed while the approval was open -> refused, external text kept
    await run("edit changed during approval", async () => {
      await fs.writeFile(file, "const x = 1\n", "utf8")
      const ctx = context(root, `s${++sessionCounter}`, async () => {
        await fs.writeFile(file, "external\n", "utf8")
      })
      await markRead(ctx, file)
      let thrown = false
      try {
        await EditTool.execute({ file_path: "a.js", old_string: "const x = 1", new_string: "const x = 2" }, ctx)
      } catch (error) {
        thrown = true
        check("edit changed message", /changed while the edit was waiting for approval; nothing was written/.test(String((error as Error).message)), String(error))
      }
      check("edit changed throws", thrown)
      check("edit changed keeps external text", (await fs.readFile(file, "utf8")) === "external\n")
    })

    // write: file changed while the approval was open -> refused, external text kept
    await run("write changed during approval", async () => {
      await fs.writeFile(file, "before\n", "utf8")
      const ctx = context(root, `s${++sessionCounter}`, async () => {
        await fs.writeFile(file, "external\n", "utf8")
      })
      await markRead(ctx, file)
      let thrown = false
      try {
        await WriteTool.execute({ file_path: "a.js", content: "written\n" }, ctx)
      } catch (error) {
        thrown = true
        check("write changed message", /changed while the edit was waiting for approval; nothing was written/.test(String((error as Error).message)), String(error))
      }
      check("write changed throws", thrown)
      check("write changed keeps external text", (await fs.readFile(file, "utf8")) === "external\n")
    })

    // write: a "new" file that appeared during the approval -> refused, its text kept
    await run("write new file appeared during approval", async () => {
      const fresh = path.join(root, "appeared.js")
      await fs.rm(fresh, { force: true })
      const ctx = context(root, `s${++sessionCounter}`, async () => {
        await fs.writeFile(fresh, "external\n", "utf8")
      })
      let thrown = false
      try {
        await WriteTool.execute({ file_path: "appeared.js", content: "written\n" }, ctx)
      } catch (error) {
        thrown = true
        check("write new file appeared message", /changed while the edit was waiting for approval/.test(String((error as Error).message)), String(error))
      }
      check("write new file appeared throws", thrown)
      check("write new file appeared keeps external text", (await fs.readFile(fresh, "utf8")) === "external\n")
    })

    // replacement lines: a lone \r in new_string never stacks into \r\r in a CRLF file
    await run("no double CR in CRLF replacement", async (ctx) => {
      await fs.writeFile(file, "a()   \r\nb()\r\n", "utf8")
      await markRead(ctx, file)
      await EditTool.execute({ file_path: "a.js", old_string: "a()\nb()", new_string: "c()\r\nd()\r" }, ctx)
      const content = await fs.readFile(file, "utf8")
      check("no \\r\\r produced", !content.includes("\r\r"), JSON.stringify(content))
      check("CRLF replacement correct", content === "c()\r\nd()\r\n", JSON.stringify(content))
    })

    // re-indentation: a whitespace-only line of new_string lands as an empty line
    await run("re-indent blank lines empty", async (ctx) => {
      await fs.writeFile(file, "function f() {\n\treturn 1\n}\n", "utf8")
      await markRead(ctx, file)
      await EditTool.execute({ file_path: "a.js", old_string: "  return 1", new_string: "  return 2\n   \n  // done" }, ctx)
      const content = await fs.readFile(file, "utf8")
      check("blank line re-indented to empty", content === "function f() {\n\treturn 2\n\n\t// done\n}\n", JSON.stringify(content))
    })

    // mixed line endings: no fuzzy tier is auto-applied, the exact not-found error wins
    await run("mixed line endings refuse fuzzy", async (ctx) => {
      await fs.writeFile(file, "a()   \r\nb()\n", "utf8")
      await markRead(ctx, file)
      let thrown = false
      try {
        await EditTool.execute({ file_path: "a.js", old_string: "a()\nb()", new_string: "c()\nd()" }, ctx)
      } catch (error) {
        thrown = true
        const message = String((error as Error).message)
        check("mixed endings not-found message", /was not found in/.test(message), message)
        check("mixed endings no fuzzy tier note", !/after ignoring/.test(message), message)
      }
      check("mixed endings throws", thrown)
      check("mixed endings leaves file unchanged", (await fs.readFile(file, "utf8")) === "a()   \r\nb()\n")
    })
  } catch (error) {
    failUnexpected(currentScenario, error)
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
