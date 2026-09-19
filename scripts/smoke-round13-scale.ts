/**
 * Round 13 (lane S): what the backend does with a lot of data - a diff of a
 * very large file, the usage page over thousands of conversations, and the
 * conversation list kept current instead of re-read (S13-1 onwards). Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundThirteenScaleChecks` with its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import type { Check } from "./smoke-round5"
import { DIFF_EDIT_LIMIT, unifiedDiff } from "../src/server/diff"

/** Rebuilds the new text from the old one and a diff, or undefined when the diff does not fit the old text. */
function applyDiff(before: string, diff: string): string | undefined {
  const old = before === "" ? [] : before.split("\n")
  const out: string[] = []
  let at = 0
  const lines = diff.split("\n").slice(2)
  for (let index = 0; index < lines.length; ) {
    const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index++])
    if (!head) return undefined
    const start = Number(head[1]) - 1
    while (at < start) out.push(old[at++])
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index++]
      const body = line.slice(1)
      if (line[0] === " " || line[0] === "-") {
        if (old[at] !== body) return undefined
        at++
      }
      if (line[0] === " " || line[0] === "+") out.push(body)
    }
  }
  while (at < old.length) out.push(old[at++])
  return out.join("\n")
}

export async function roundThirteenScaleChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------------ S13-1
  section("Round 13 (S13-1): a diff of a very large file stays quick and small")
  {
    // What the line-by-line table this replaced printed for the same edits, byte for byte.
    const golden: [string, string, string][] = [
      ["one\ntwo\nthree\n", "one\nTWO\nthree\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n "],
      ["", "brand new\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +1,2 @@\n+brand new\n+"],
      [
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n",
        "a\nb\nX\nc\nd\ne\nf\ng\nh\ni\nj\nk\nm\nZ\n",
        "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n a\n b\n+X\n c\n d\n e\n@@ -9,6 +10,6 @@\n i\n j\n k\n-l\n m\n+Z\n ",
      ],
      [
        "function f() {\n  return 1\n}\n\nfunction g() {\n  return 2\n}\n",
        "function f() {\n  return 10\n}\n\nfunction h() {\n  return 3\n}\n\nfunction g() {\n  return 2\n}\n",
        "--- a/f.txt\n+++ b/f.txt\n@@ -1,7 +1,11 @@\n function f() {\n-  return 1\n+  return 10\n }\n \n+function h() {\n+  return 3\n+}\n+\n function g() {\n   return 2\n }",
      ],
      ["keep\nremove me\nkeep too\n", "keep\nkeep too\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,3 @@\n keep\n-remove me\n keep too\n "],
      ["x\ny\n", "", "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,0 @@\n-x\n-y\n-"],
    ]
    const drifted = golden.filter(([before, after, expected]) => unifiedDiff("f.txt", before, after) !== expected)
    check("ordinary edits print exactly what they printed before", drifted.length === 0, drifted.map(([a, b]) => unifiedDiff("f.txt", a, b)))
    check("identical sides still give nothing", unifiedDiff("f.txt", "same\n", "same\n") === "")

    // Random small edits over a small vocabulary (so lines repeat): the diff must rebuild the new side and change no more lines than needed.
    let seed = 13
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const vocabulary = ["{", "}", "", "  return x", "foo()", "bar()", "// note"]
    const broken: unknown[] = []
    for (let round = 0; round < 3000 && broken.length < 3; round++) {
      const a = Array.from({ length: 1 + Math.floor(random() * 30) }, () =>
        random() < 0.5 ? vocabulary[Math.floor(random() * vocabulary.length)] : `line ${Math.floor(random() * 100)}`,
      )
      const b = a.slice()
      for (let edit = 1 + Math.floor(random() * 4); edit > 0; edit--) {
        const kind = random()
        const at = Math.floor(random() * (b.length + 1))
        if (kind < 0.33) b.splice(at, 1)
        else if (kind < 0.66) b.splice(at, 0, vocabulary[Math.floor(random() * vocabulary.length)])
        else b[at] = `changed ${round}`
      }
      const diff = unifiedDiff("f", a.join("\n"), b.join("\n"))
      if (applyDiff(a.join("\n"), diff) !== b.join("\n")) broken.push({ a, b, diff })
    }
    check("every diff of a random edit rebuilds the new text from the old", broken.length === 0, broken)

    const big = (n: number) => Array.from({ length: n }, (_, i) => `const value${i} = compute(${i}) // line ${i}`)
    for (const n of [40_000, 70_000]) {
      const lines = big(n)
      const before = lines.join("\n")
      lines[n >> 1] = "const changed = true"
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before, lines.join("\n"))
      const took = performance.now() - started
      check(`one line changed in ${n} lines takes well under a second`, took < 500 && diff.split("\n").length === 11, [Math.round(took), diff])
      check(`and it is the usual one-line hunk (${n})`, diff.includes(`@@ -${(n >> 1) - 2},7 +${(n >> 1) - 2},7 @@`) && diff.includes("\n+const changed = true"), diff)
    }

    // Scattered edits up to the budget are still aligned line by line.
    {
      const before = big(40_000)
      const after = before.map((line, i) => (i % 50 === 0 ? `${line} // edited` : line))
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before.join("\n"), after.join("\n"))
      const took = performance.now() - started
      check("800 scattered edits in 40000 lines are aligned, quickly", took < 1000 && applyDiff(before.join("\n"), diff) === after.join("\n") && diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length === 800, Math.round(took))
    }

    // Past the budget the changed middle is one replaced block: every old line out, then every new one in.
    {
      const before = big(70_000)
      const after = before.map((line) => `${line}!`)
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before.join("\n"), after.join("\n"))
      const took = performance.now() - started
      const body = diff.split("\n").slice(3)
      const firstAdd = body.findIndex((line) => line.startsWith("+"))
      check(
        `a rewrite of 70000 lines (past ${DIFF_EDIT_LIMIT} edits) is one replaced block, in well under a second`,
        took < 1000 && firstAdd === 70_000 && body.slice(0, firstAdd).every((line) => line.startsWith("-")) && body.slice(firstAdd).every((line) => line.startsWith("+")),
        [Math.round(took), firstAdd],
      )
      check("and it still rebuilds the new text", applyDiff(before.join("\n"), diff) === after.join("\n"))
      // A replaced block with the same lines around it keeps them as context.
      const framed = ["top", ...before.slice(0, 5000), "bottom"]
      const reframed = ["top", ...before.slice(0, 5000).map((line) => `${line}?`), "bottom"]
      const diff2 = unifiedDiff("f.ts", framed.join("\n"), reframed.join("\n"))
      check("the lines around a replaced block stay as context", diff2.split("\n")[2] === "@@ -1,5002 +1,5002 @@" && diff2.split("\n")[3] === " top" && diff2.endsWith("\n bottom"), diff2.split("\n").slice(0, 4))
    }
  }
}
