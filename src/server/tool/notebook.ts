import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { unifiedDiff } from "../diff"
import { guardPlanWrite } from "../session/plan"

interface NotebookCell {
  cell_type: string
  id?: string
  source: string[] | string
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

interface Notebook {
  cells?: NotebookCell[]
  nbformat_minor?: number
}

/** A cell's source as Jupyter stores it: one entry per line, each but the last ending in a newline. */
function cellSource(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line)).filter((line) => line !== "")
}

/** An eight-character cell id no other cell in the notebook has. */
function newCellID(taken: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
  return randomUUID()
}

function buildCell(type: string, source: string, id: string): NotebookCell {
  if (type === "code") return { cell_type: "code", id, source: cellSource(source), metadata: {}, outputs: [], execution_count: null }
  return { cell_type: "markdown", id, source: cellSource(source), metadata: {} }
}

export const NotebookEditTool: ToolDefinition = {
  name: "notebook_edit",
  description:
    "Change one cell of a Jupyter notebook (.ipynb): replace its source, insert a new cell after it, or delete it. Name the cell by its id, or by its position as #N counting from 0. Replacing a code cell keeps its outputs.",
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      notebook_path: { type: "string", description: "Path of the .ipynb file, absolute or relative to the project root" },
      cell_id: {
        type: "string",
        description: "The cell's id, or #N for its position. Required to replace or delete; to insert, the new cell goes after this one, or first when left out",
      },
      new_source: { type: "string", description: "The cell's new source. Required to replace or insert" },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Required to insert; when replacing, the cell keeps its own type unless this says otherwise" },
      edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "What to do, replace when left out" },
    },
    required: ["notebook_path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const mode = typeof input.edit_mode === "string" ? input.edit_mode : "replace"
    const given = String(input.notebook_path ?? "")
    if (!given) throw new ToolError("notebook_path is required")
    if (path.extname(given) !== ".ipynb") throw new ToolError("notebook_path has to name a .ipynb file")
    const cellID = typeof input.cell_id === "string" && input.cell_id ? input.cell_id : undefined
    if (mode !== "insert" && !cellID) throw new ToolError(`cell_id is required to ${mode} a cell`)
    const newSource = typeof input.new_source === "string" ? input.new_source : undefined
    if ((mode === "replace" || mode === "insert") && newSource === undefined) throw new ToolError(`new_source is required to ${mode} a cell`)
    const cellType = typeof input.cell_type === "string" ? input.cell_type : undefined
    if (mode === "insert" && !cellType) throw new ToolError("cell_type is required to insert a cell")

    const target = await resolvePath(context, given)
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const before = await fs.readFile(target, "utf8").catch(() => undefined)
    if (before === undefined) throw new ToolError(`Notebook not found: ${display}`)
    let notebook: Notebook
    try {
      notebook = JSON.parse(before) as Notebook
    } catch (err) {
      throw new ToolError(`The notebook is not valid JSON: ${(err as Error).message}`)
    }
    const cells = notebook.cells
    if (!Array.isArray(cells)) throw new ToolError("The file has no cells array, so it does not look like a Jupyter notebook")

    // Cells from before nbformat 4.5 have no ids; they get them, and the notebook is marked as the version that has them.
    const taken = new Set(cells.flatMap((cell) => (cell.id ? [cell.id] : [])))
    let backfilled = false
    for (const cell of cells) {
      if (cell.id) continue
      cell.id = newCellID(taken)
      taken.add(cell.id)
      backfilled = true
    }
    if (backfilled && (notebook.nbformat_minor ?? 0) < 5) notebook.nbformat_minor = 5

    const indexOf = (ref: string) => {
      if (ref.startsWith("#")) {
        const index = Number.parseInt(ref.slice(1), 10)
        return Number.isInteger(index) && index >= 0 && index < cells.length ? index : -1
      }
      return cells.findIndex((cell) => cell.id === ref)
    }
    const notFound = (ref: string) =>
      new ToolError(`No cell ${ref} in ${display}. Its cells are: ${cells.map((cell, index) => cell.id ?? `#${index}`).join(", ") || "(none)"}`)

    let change: string
    if (mode === "replace") {
      const index = indexOf(cellID!)
      if (index === -1) throw notFound(cellID!)
      const old = cells[index]
      const type = cellType ?? (old.cell_type === "raw" ? "code" : old.cell_type)
      const cell = buildCell(type, newSource ?? "", old.id ?? cellID!)
      cell.metadata = old.metadata ?? {}
      if (old.cell_type === "code" && type === "code") {
        cell.outputs = old.outputs ?? []
        cell.execution_count = old.execution_count ?? null
      }
      cells[index] = cell
      change = `replace cell ${old.id ?? `#${index}`}`
    } else if (mode === "delete") {
      const index = indexOf(cellID!)
      if (index === -1) throw notFound(cellID!)
      cells.splice(index, 1)
      change = `delete cell ${cellID}`
    } else {
      const cell = buildCell(cellType!, newSource ?? "", newCellID(taken))
      if (!cellID) {
        cells.unshift(cell)
        change = "insert cell at start"
      } else {
        const index = indexOf(cellID)
        if (index === -1) throw notFound(cellID)
        cells.splice(index + 1, 0, cell)
        change = `insert cell after ${cellID}`
      }
    }

    const after = JSON.stringify(notebook, null, 1) + (before.endsWith("\n") ? "\n" : "")
    const diff = unifiedDiff(display, before, after)
    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "edit",
      directory: context.directory,
      title: "Edit notebook",
      subject: display,
      preview: diff,
    })
    await context.snapshot(target)
    await fs.writeFile(target, after, "utf8")

    return {
      output: `Changed ${display}: ${change}.`,
      title: `${display} — ${change}`,
      metadata: { path: display, diff, edit_mode: mode, cell_id: cellID },
    }
  },
}
