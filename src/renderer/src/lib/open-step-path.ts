import { openFileInViewer } from "./office-open"
import { notifyFailure } from "./toast"
import { t } from "./i18n"

/**
 * MiMo's Ctrl/⌘+click on a read, edit or write step's path.
 *
 * A web page opens in the system's own browser, not in this app's page tab:
 * the step is about the file, and that is where MiMo sends it. Text, data,
 * source and pictures open in the files tab beside the conversation. Anything
 * else is shown in the file manager, and a path that cannot be found says so.
 */

const TEXT = new Set(["md", "markdown", "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "env", "abc"])
const CODE = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro", "py", "rb", "go", "rs", "java", "kt", "kts",
  "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "css",
  "scss", "sass", "less", "lua", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "clj", "gradle", "makefile",
  "dockerfile", "proto", "graphql", "gql", "tf", "nix", "zig",
])
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])

const normal = (value: string) => value.replace(/\\/g, "/")

function extensionOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return (dot > 0 ? name.slice(dot + 1) : name).toLowerCase()
}

function failed(error?: string) {
  if (!error || /ENOENT|not exist|no such file|cannot find/i.test(error)) notifyFailure(t("harnessRow.pathNotExist"))
  else notifyFailure(t("harnessRow.revealFailed", { error }))
}

export async function openStepPath(file: string, directory?: string): Promise<void> {
  const root = directory ? normal(directory).replace(/\/+$/, "") : ""
  const absolute = /^([a-zA-Z]:)?[\\/]/.test(file) || !root ? normal(file) : `${root}/${normal(file).replace(/^\.\//, "")}`
  const extension = extensionOf(absolute)

  if ((extension === "html" || extension === "htm") && root && absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    // Handed to the desktop; a non-empty answer is its reason for refusing.
    const refused = await window.mcode.openFile(root, absolute.slice(root.length + 1)).catch((error: unknown) => String(error))
    if (refused) failed(refused)
    return
  }

  if (TEXT.has(extension) || CODE.has(extension) || IMAGE.has(extension)) {
    openFileInViewer(absolute, directory)
    return
  }

  const result = await window.mcode.revealPath(absolute).catch((error: unknown) => ({ ok: false, error: String(error) }))
  if (!result.ok) failed(result.error)
}
