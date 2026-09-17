import path from "node:path"
import type { Bus } from "../bus"
import type { Config } from "../config"
import { scratchDirectory } from "../scratch"
import type { SessionRunner } from "../session/runner"
import type { SessionStore } from "../session/store"
import { interfaceLocale } from "../session/locale"
import { AutomationService, bindAutomations } from "./service"

/** automation: the scheduled tasks bound to this backend's runner and store. */
export function startAutomations(dataDirectory: string, runner: SessionRunner, sessions: SessionStore, config: Config, bus: Bus): AutomationService {
  const service = new AutomationService({
    file: path.join(dataDirectory, "automations.json"),
    now: () => Date.now(),
    sessions,
    prompt: (input) => runner.prompt(input),
    busy: (sessionID) => runner.isRunning(sessionID),
    models: () =>
      config
        .providers()
        .filter((provider) => provider.configured)
        .flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, id: model.id, name: model.name }))),
    agent: () => config.get().agent,
    effort: () => config.get().effort,
    scratch: () => scratchDirectory(new Date(), config.get().projectRoot),
    publish: (event) => bus.publish(event),
    locale: () => interfaceLocale(config.get().language),
  })
  bus.subscribe((event) => {
    if (event.type === "session.idle") void service.turnEnded(event.sessionID)
  })
  bindAutomations(service)
  void service.start()
  return service
}
