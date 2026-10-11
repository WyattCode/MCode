import type { ToolPart } from "./protocol"
export type OperationKind = "browser" | "computer"

/** Marks real app operations, rather than network requests such as webfetch. */
export function operationKind(part: ToolPart, previous?: OperationKind): OperationKind | undefined {
  if (part.name !== "app") return undefined
  if (part.metadata?.operationKind === "none") return undefined
  if (part.metadata?.operationKind === "browser" || part.metadata?.operationKind === "computer") return part.metadata.operationKind
  const action = part.input.action
  if (action === "open") return "browser"
  if (["window", "launch", "android", "attach"].includes(String(action))) return "computer"
  return previous
}
