import type { ToolDefinition } from "./types"

/**
 * Where a tool call that could not be dispatched ends up.
 *
 * A transcription of the reference's `InvalidTool` (node-BBwF64dM.js
 * @23395251): name `invalid`, description "Do not use", parameters
 * `{tool, error}`, and a result whose title is "Invalid Tool" and whose output
 * is one sentence naming what went wrong.
 *
 * The model never sees it. The reference keeps it out of the request with
 * `activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid")`
 * (@22827789) and reaches it only from the AI SDK's repair hook
 * (@22826700): a call whose name or arguments the SDK could not resolve is
 * rewritten to `{toolName: "invalid", input: {tool, error}}`. This app keeps it
 * out of the request the same way - it is not in `TOOLS`, so nothing offers it
 * - and reaches it from the same place in spirit, the runner's dispatch.
 *
 * The point is that a bad call becomes something the model can read and correct
 * rather than a bare failure. Before this, an unrecognised name produced the
 * part error "Unknown tool: X", which says nothing about which of the names it
 * does have was meant.
 */
export const InvalidTool: ToolDefinition = {
  name: "invalid",
  description: "Do not use",
  parameters: {
    type: "object",
    properties: {
      tool: { type: "string" },
      error: { type: "string" },
    },
    required: ["tool", "error"],
    additionalProperties: false,
  },
  async execute(input) {
    return {
      title: "Invalid Tool",
      output: `The arguments provided to the tool are invalid: ${String(input.error ?? "")}`,
      metadata: {},
    }
  },
}
