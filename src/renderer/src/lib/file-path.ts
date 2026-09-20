/**
 * A document's folder and its own name, the pair every viewer hands the
 * Office channels (`readFileBytes(dir, base)`).
 *
 * The folder keeps its trailing separator: "D:" alone is not an absolute path
 * at all - Windows reads it as the current directory on that drive - so a file
 * at a drive root is refused before it is read, while "D:\" names the root.
 * One helper because each view used to carry its own copy and three of them
 * were still cutting the separator off.
 */
export function splitFilePath(file: string): readonly [dir: string, base: string] {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return [file.slice(0, cut + 1), file.slice(cut + 1)] as const
}
