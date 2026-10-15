import path from "node:path"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { allowProjectTools } from "./edit"
import { lspDiagnostics, lspRequest, serverForFile, formatLspDiagnostics } from "../lsp"

type LspAction = "diagnostics" | "definition" | "references" | "hover"

const isLspAction = (value: string): value is LspAction =>
  value === "diagnostics" || value === "definition" || value === "references" || value === "hover"

/**
 * Ask a language server about a file: its diagnostics, or a definition,
 * references or hover at a position. Read-only - it opens the file with the
 * server but changes nothing on disk.
 */
export const LspTool: ToolDefinition = {
  name: "lsp",
  description: [
    "Ask a language server about a file. Read-only: it changes nothing.",
    "",
    "Uses typescript-language-server for .ts/.tsx/.js/.jsx files and pyright-langserver for .py files, when one is installed (on PATH, or in the project's node_modules when project tools are allowed). When neither is installed it says so rather than failing.",
    "",
    "- action \"diagnostics\": the errors and warnings the server reports for the file.",
    "- action \"definition\": where the symbol at line/column is defined.",
    "- action \"references\": every place the symbol at line/column is used.",
    "- action \"hover\": the documentation and type the server shows for the symbol at line/column.",
    "",
    "line and column are 1-based, counting from the read tool's line numbers. definition, references and hover need both.",
  ].join("\n"),
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diagnostics", "definition", "references", "hover"], description: "What to ask the server" },
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      line: { type: "integer", description: "Line of the position, counting from 1 (definition, references, hover)" },
      column: { type: "integer", description: "Column of the position, counting from 1 (definition, references, hover)" },
    },
    required: ["action", "file_path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const action = String(input.action)
    if (!isLspAction(action)) {
      throw new ToolError(`action must be diagnostics, definition, references or hover: ${action}`)
    }
    const target = await resolvePath(context, String(input.file_path), "read")
    const display = relative(context.directory, target)
    const allow = allowProjectTools(context)
    const spec = serverForFile(target)
    if (!spec) {
      const ext = path.extname(target) || "this"
      return {
        output: `No language server is available for ${ext} files (install typescript-language-server or pyright).`,
        title: display,
        metadata: { path: display, action, server: null },
      }
    }
    if (action === "diagnostics") {
      const result = await lspDiagnostics(target, context.directory, { signal: context.signal, allowProjectTools: allow })
      if (!result) {
        return {
          output: `No language server is available for ${path.extname(target)} files (install typescript-language-server or pyright).`,
          title: display,
          metadata: { path: display, action, server: null },
        }
      }
      if (!result.diagnostics.length) {
        return { output: `No diagnostics for ${display}.`, title: display, metadata: { path: display, action, server: result.server, errors: 0, diagnostics: [] } }
      }
      return {
        output: formatLspDiagnostics(display, result).trim(),
        title: display,
        metadata: { path: display, action, server: result.server, errors: result.errors, diagnostics: result.diagnostics },
      }
    }
    const line = Number(input.line)
    const column = Number(input.column)
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      throw new ToolError(`${action} needs a line and column (both counting from 1)`)
    }
    const result = await lspRequest(action, target, line, column, context.directory, { signal: context.signal, allowProjectTools: allow })
    if (result === undefined) {
      return { output: `No ${action} found for ${display}:${line}:${column}.`, title: display, metadata: { path: display, action, server: spec.id } }
    }
    return { output: result, title: display, metadata: { path: display, action, server: spec.id } }
  },
}
