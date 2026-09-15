/**
 * MiMo's turn power hold: while any conversation is mid-turn the system is kept
 * from suspending, and the hold is let go when the last turn ends.
 *
 * One OS blocker for any number of turns, so the count lives here rather than
 * in Electron. Nothing here imports Electron, so smoke can hold the counting.
 */

export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number
  stop(id: number): void
}

export class PowerHold {
  private readonly held = new Set<string>()
  private id: number | undefined

  constructor(
    private readonly blocker: PowerBlocker,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Brings the held set to exactly these busy sessions, starting or stopping the blocker at the edges. */
  sync(busy: readonly string[]): void {
    const next = new Set(busy)
    for (const entry of [...this.held]) if (!next.has(entry)) this.release(entry)
    for (const entry of next) this.add(entry)
  }

  add(key: string): void {
    if (this.held.has(key)) return
    this.held.add(key)
    if (this.held.size !== 1) return
    try {
      this.id = this.blocker.start("prevent-app-suspension")
      this.log(`[power] hold started for ${key}`)
    } catch (err) {
      // A blocker that cannot start leaves nothing to stop; the next turn tries again.
      this.held.delete(key)
      this.id = undefined
      this.log(`[power] hold failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  release(key: string): void {
    if (!this.held.delete(key) || this.held.size !== 0) return
    const id = this.id
    this.id = undefined
    if (id === undefined) return
    try {
      this.blocker.stop(id)
      this.log(`[power] hold released after ${key}`)
    } catch (err) {
      this.log(`[power] hold failed to stop: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  get state(): { held: string[]; id: number | undefined } {
    return { held: [...this.held], id: this.id }
  }
}
