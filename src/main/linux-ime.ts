/**
 * The fcitx input method on Linux, as MiMo sets it up at start.
 *
 * Started from some launchers, the app inherits an environment without
 * GTK_IM_MODULE / QT_IM_MODULE / XMODIFIERS even though fcitx is running, and
 * then no Chinese can be typed. The method is taken from whichever of those is
 * already set, else from the `run_im` line of ~/.xinputrc (im-config), and
 * only the variables that are missing are filled in; a value the user set is
 * never replaced. Other input methods are left alone.
 */

/** fcitx, fcitx5 and so on, as a module name. */
function isFcitx(value: string | undefined): value is string {
  return typeof value === "string" && /^fcitx\d*$/.test(value)
}

/** The method named in the environment, if it is an fcitx. */
function fromEnvironment(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const gtk = env.GTK_IM_MODULE?.trim()
  if (isFcitx(gtk)) return gtk
  const qt = env.QT_IM_MODULE?.trim()
  if (isFcitx(qt)) return qt
  const modifiers = /@im=(fcitx\d*)\b/.exec(env.XMODIFIERS ?? "")
  return modifiers?.[1]
}

/**
 * The method ~/.xinputrc starts, when it is an fcitx. The last `run_im` line
 * wins, as the shell running the file would have it; Sogou Pinyin runs on fcitx.
 */
export function fromXinputrc(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined
  let last: string | undefined
  for (const match of text.matchAll(/^[ \t]*run_im[ \t]+(\S+)/gm)) last = match[1].toLowerCase()
  if (last === "fcitx5") return "fcitx5"
  if (last === "fcitx" || last === "sogoupinyin" || last === "sogou") return "fcitx"
  return undefined
}

/** The variables to add to this process's environment; empty off Linux or without fcitx. */
export function fcitxEnvironment(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  readXinputrc: () => string | undefined,
): Record<string, string> {
  if (platform !== "linux") return {}
  let method = fromEnvironment(env)
  if (!method) {
    try {
      method = fromXinputrc(readXinputrc())
    } catch {
      method = undefined
    }
  }
  if (!method) return {}
  const add: Record<string, string> = {}
  if (!env.GTK_IM_MODULE?.trim()) add.GTK_IM_MODULE = method
  if (!env.QT_IM_MODULE?.trim()) add.QT_IM_MODULE = method
  if (!env.XMODIFIERS?.trim()) add.XMODIFIERS = `@im=${method}`
  return add
}
