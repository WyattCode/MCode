/**
 * A path as MiMo shows it: the home folder written as `~` when the path is
 * inside it, the path itself otherwise. The full path stays for a tooltip.
 */
export function homePath(target: string, home: string | undefined): string {
  if (!home || !target.startsWith(home)) return target
  const rest = target.slice(home.length)
  return rest === "" || rest[0] === "/" || rest[0] === "\\" ? `~${rest}` : target
}
