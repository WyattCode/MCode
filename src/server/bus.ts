import type { ServerEvent } from "@shared/protocol"

type Listener = (event: ServerEvent) => void

/**
 * Fan-out point for everything the UI needs to know about.
 *
 * The runtime never talks to sockets directly - it publishes here, and the
 * WebSocket layer is just one subscriber. That keeps the agent loop testable
 * without a client attached, and lets several windows observe the same session.
 */
export class Bus {
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[bus] listener failed", err)
      }
    }
  }
}
