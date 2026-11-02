import { openFileInViewer } from "./office-open"
import { notifyFailure } from "./toast"
import { t } from "./i18n"
import { useApp } from "../stores/app"

/**
 * MiMo's Ctrl/⌘+click on a read, edit or write step's path.
 *
 * A web page opens in the system's own browser, not in this app's page tab:
 * the step is about the file, and that is where MiMo sends it. Text, data,
 * source and pictures open in the files tab beside the conversation. Anything
 * else is shown in the file manager, and a path that cannot be found says so.
 */

/*
 * What opens in the panel, as MiMo's own four tests read a path: the same
 * suffixes in the same order, each allowing a query or a fragment after them.
 *
 * Written as patterns rather than as sets of suffixes (R17-V6) because that is
 * what they have to be: `.gitignore`, `.editorconfig` and their kind are a
 * whole name, and a set keyed on "the part after the last dot" cannot hold
 * them. Two dozen suffixes MiMo shows - mdx, rst, org, tex, adoc, pyw, cljs,
 * groovy, nim, properties - were missing here as well.
 */
const TEXT = /\.(md|markdown|mdx|txt|text|rst|org|log|csv|tsv|json|jsonc|ya?ml|toml|ini|conf|cfg|xml|tex|adoc)(?:[?#].*)?$/i
const ABC = /\.abc(?:[?#].*)?$/i
const CODE =
  /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|ux|py|pyw|rb|go|rs|java|kt|kts|scala|clj|cljs|swift|php|c|h|cc|cpp|cxx|hpp|hh|cs|m|mm|sh|bash|zsh|fish|ps1|bat|cmd|sql|css|scss|sass|less|styl|lua|r|dart|groovy|gradle|pl|pm|ex|exs|erl|hs|elm|nim|zig|proto|graphql|gql|env|properties|gitignore|gitattributes|editorconfig)(?:[?#].*)?$/i
const IMAGE = /\.(svg|png|jpe?g|gif|webp|bmp|avif|ico)(?:[?#].*)?$/i
const HTML = /\.html?(?:[?#].*)?$/i

const normal = (value: string) => value.replace(/\\/g, "/")

const nameOf = (file: string) => file.split(/[\\/]/).pop() ?? ""

function failed(error?: string) {
  if (!error || /ENOENT|not exist|no such file|cannot find/i.test(error)) notifyFailure(t("harnessRow.pathNotExist"))
  else notifyFailure(t("harnessRow.revealFailed", { error }))
}

export async function openStepPath(file: string, directory?: string): Promise<void> {
  const root = directory ? normal(directory).replace(/\/+$/, "") : ""
  const absolute = /^([a-zA-Z]:)?[\\/]/.test(file) || !root ? normal(file) : `${root}/${normal(file).replace(/^\.\//, "")}`
  const name = nameOf(absolute)
  // Hold failure toasts to the conversation the open started in; leaving mid-await must not flash them elsewhere.
  const held = useApp().currentID

  if (HTML.test(name)) {
    // Handed to the desktop wherever the page lives, as MiMo hands it over - a page outside the project too.
    if (root && absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      // A non-empty answer is the backend's reason for refusing.
      const refused = await window.mcode.openFile(root, absolute.slice(root.length + 1)).catch((error: unknown) => String(error))
      if (useApp().currentID !== held) return
      if (refused) failed(refused)
      return
    }
    const opened = await window.mcode.openNativePath(absolute).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
    if (useApp().currentID !== held) return
    if (!opened.ok) failed(opened.error)
    return
  }

  if (TEXT.test(name) || ABC.test(name) || CODE.test(name) || IMAGE.test(name)) {
    openFileInViewer(absolute, directory)
    return
  }

  const result = await window.mcode.revealPath(absolute).catch((error: unknown) => ({ ok: false, error: String(error) }))
  if (useApp().currentID !== held) return
  if (!result.ok) failed(result.error)
}
