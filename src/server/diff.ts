/**
 * Minimal line-level unified diff.
 *
 * Used for two things: the preview inside the permission dialog, and the
 * metadata the UI renders as a colored diff on the tool card. Both are display
 * concerns, so a straightforward LCS is plenty - nothing here is fed back to
 * a patch program.
 */

interface Op {
  kind: "equal" | "delete" | "insert"
  line: string
}

function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
    }
  }
  return table
}

function diffLines(a: string[], b: string[]): Op[] {
  const width = b.length + 1
  const table = lcsMatrix(a, b)
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", line: a[i] })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ kind: "delete", line: a[i] })
      i++
    } else {
      ops.push({ kind: "insert", line: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ kind: "delete", line: a[i++] })
  while (j < b.length) ops.push({ kind: "insert", line: b[j++] })
  return ops
}

const CONTEXT = 3

/**
 * Renders a unified diff with the usual @@ hunk headers. Returns an empty
 * string when the two sides are identical.
 */
export function unifiedDiff(filename: string, before: string, after: string): string {
  if (before === after) return ""

  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  const ops = diffLines(a, b)

  // Indices of ops that are near a change and therefore belong in some hunk.
  const keep = new Set<number>()
  ops.forEach((op, index) => {
    if (op.kind === "equal") return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep.add(k)
  })
  if (keep.size === 0) return ""

  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`]

  let index = 0
  let oldLine = 1
  let newLine = 1
  while (index < ops.length) {
    if (!keep.has(index)) {
      if (ops[index].kind !== "insert") oldLine++
      if (ops[index].kind !== "delete") newLine++
      index++
      continue
    }

    const hunk: string[] = []
    const oldStart = oldLine
    const newStart = newLine
    let oldCount = 0
    let newCount = 0
    while (index < ops.length && keep.has(index)) {
      const op = ops[index]
      if (op.kind === "equal") {
        hunk.push(` ${op.line}`)
        oldCount++
        newCount++
        oldLine++
        newLine++
      } else if (op.kind === "delete") {
        hunk.push(`-${op.line}`)
        oldCount++
        oldLine++
      } else {
        hunk.push(`+${op.line}`)
        newCount++
        newLine++
      }
      index++
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    lines.push(...hunk)
  }

  return lines.join("\n")
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}
