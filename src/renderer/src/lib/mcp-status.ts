import type { McpStatus } from "@shared/protocol"

/**
 * One reading of an MCP server's status for every surface that shows it, as
 * MiMo's mcpStatus module is: a colour, and the name it is shown under. Both
 * sign-in states read as waiting for authorization and offer 授权.
 */
export const MCP_STATUS_TONE: Record<McpStatus, "ok" | "err" | "warn" | "muted"> = {
  connected: "ok",
  failed: "err",
  needs_auth: "warn",
  needs_client_registration: "warn",
  pending: "muted",
  disabled: "muted",
}

export function isMcpStatus(value: unknown): value is McpStatus {
  return typeof value === "string" && value in MCP_STATUS_TONE
}

/** The status whose label a state is shown with. */
export function mcpStatusLabel(status: McpStatus): Exclude<McpStatus, "needs_client_registration"> {
  return status === "needs_client_registration" ? "needs_auth" : status
}

/** Whether the server waits on a sign-in (or on a client id to sign in with). */
export function mcpNeedsSignIn(status: string): boolean {
  return status === "needs_auth" || status === "needs_client_registration"
}
