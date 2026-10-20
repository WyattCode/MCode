import type { ToolPart } from "./protocol"
export type OperationKind = "browser" | "computer"

/** Marks real app operations, rather than network requests such as webfetch. */
export function operationKind(part: ToolPart, previous?: OperationKind): OperationKind | undefined {
  if (part.name !== "app") return undefined
  if (part.metadata?.operationKind === "none") return undefined
  if (part.metadata?.operationKind === "browser" || part.metadata?.operationKind === "computer") return part.metadata.operationKind
  // `input` can be absent on a pending part; guard so the lookup never throws.
  const action = (part.input as { action?: unknown } | undefined)?.action
  if (action === "open") return "browser"
  if (["window", "launch", "android", "attach"].includes(String(action))) return "computer"
  return previous
}
