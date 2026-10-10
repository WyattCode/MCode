import { isSpaceLess, t } from "./i18n"

/**
 * The sentence for a local runtime that did not answer.
 *
 * "Start it and try again" is the right advice for a runtime that is not
 * running and the wrong advice for one that is: on macOS a denied Local Network
 * permission fails the request the same way, and sends the user off to debug a
 * process that was working the whole time. Loopback is exempt, so the hint is
 * only added when the address points somewhere else.
 */
export function localDownMessage(name: string, url: string, network: boolean): string {
  const said = t("auth.localDown", { name, url })
  if (!network) return said
  // The two sentences are joined the way the language joins them: a full stop
  // and a space between Latin words, but nothing between CJK ones.
  return `${said}${isSpaceLess() ? "" : " "}${t("auth.localNetwork")}`
}

/** Whether a local runtime's address points off this machine, as the backend judges it. */
export function offMachine(url: string | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost"))
}