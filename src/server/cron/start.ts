import type { Bus } from "../bus"
import type { Config } from "../config"
import type { SessionRunner } from "../session/runner"
import type { SessionStore } from "../session/store"
import { CronScheduler, bindScheduler } from "./scheduler"

/**
 * cron: the scheduler bound to this backend's runner. A fired prompt is an
 * ordinary prompt, and a conversation's finished turn is when its loops are
 * looked at again.
 */
export function startScheduler(runner: SessionRunner, sessions: SessionStore, config: Config, bus: Bus): CronScheduler {
  const scheduler = new CronScheduler({
    now: () => Date.now(),
    fire: async (sessionID, text) => {
      await runner.prompt({ sessionID, text })
    },
    busy: (sessionID) => runner.isRunning(sessionID),
    session: (sessionID) => sessions.get(sessionID),
    directories: async () => [...new Set([...(await sessions.list()).map((session) => session.directory), ...(config.get().projects ?? [])])],
  })
  bus.subscribe((event) => {
    if (event.type === "session.idle") scheduler.turnEnded(event.sessionID)
  })
  bindScheduler(scheduler)
  void scheduler.start()
  return scheduler
}
