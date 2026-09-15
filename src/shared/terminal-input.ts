/**
 * Whether terminal input came from a person rather than from the terminal answering.
 *
 * xterm sends focus reports, device-attribute replies and cursor reports down
 * the same channel as keystrokes. None of those is anyone using the shell, and
 * counting them would make every terminal ask before it closes. Shared so the
 * pane and the backend agree on what "used" means.
 */
export function typedInput(data: string): boolean {
  if (!data) return false
  return !/^(?:\x1b\[[IO]|\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R)+$/.test(data)
}
