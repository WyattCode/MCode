/**
 * MiMo's shortcuts page: one fixed list in the order of its default table,
 * each row a label over a one-line description.
 *
 * A row names the MCode command that does the same job. Rows whose command does
 * not exist in this build are left off rather than drawn as dead rows. A row
 * may list a second command to fall back on, drawn under that command's own
 * title because MiMo's words would not describe it (MiMo's 关闭 closes the
 * window; MCode's Ctrl+W may still close a tab).
 *
 * MiMo's 插件, 自动化 and 移动应用 rows are not here: the plugins page is hidden
 * at the user's request and MCode has neither of the other two.
 */
export interface PageRow {
  /** MiMo's id, which names the label and description keys. */
  key: string
  /** The command that does MiMo's job, then any MCode stand-in. */
  commands: readonly string[]
  /** For 转到聊天 N. */
  n?: number
  /** False where MiMo's description would be untrue of MCode's command. */
  desc?: boolean
}

export const PAGE_ROWS: readonly PageRow[] = [
  { key: "conv-archive", commands: ["session.archive"] },
  // MCode's new task starts in the open project, so MiMo's "without a project" line is left off.
  { key: "new-chat", commands: ["session.new"], desc: false },
  { key: "side-chat", commands: ["session.side"] },
  { key: "conv-pin", commands: ["session.pin"] },
  { key: "conv-rename", commands: ["session.rename"] },
  { key: "priority-filter-toggle", commands: ["view.priority"] },
  { key: "find", commands: ["app.find"] },
  { key: "browser-focus", commands: ["browser.address"] },
  { key: "focus-composer", commands: ["input.focus"] },
  { key: "nav-back", commands: ["app.back"] },
  { key: "nav-fwd", commands: ["app.forward"] },
  { key: "next-recent", commands: ["session.nextRecent"] },
  { key: "next-tab", commands: ["session.next"] },
  { key: "prev-recent", commands: ["session.prevRecent"] },
  { key: "prev-tab", commands: ["session.previous"] },
  { key: "open-browser", commands: ["browser.tab"] },
  { key: "open-review", commands: ["view.review"] },
  { key: "toggle-bottom", commands: ["view.bottom"] },
  { key: "toggle-browser", commands: ["view.browser"] },
  { key: "toggle-sidebar", commands: ["view.left"] },
  { key: "toggle-right", commands: ["view.right"] },
  { key: "open-terminal", commands: ["view.terminal"] },
  { key: "open-folder", commands: ["project.open"] },
  { key: "settings", commands: ["app.settings"] },
  { key: "close-window", commands: ["window.close", "tab.close"] },
  { key: "cycle-reasoning", commands: ["model.variant.cycle"] },
  { key: "decrease-reasoning", commands: ["effort.decrease"] },
  { key: "increase-reasoning", commands: ["effort.increase"] },
  { key: "model-picker", commands: ["view.model"] },
  { key: "toggle-voice", commands: ["voice.toggle"] },
  { key: "send-message", commands: ["composer.send"] },
  { key: "toggle-plan", commands: ["composer.staged.toggle"] },
  { key: "copy-md", commands: ["session.copyMarkdown"] },
  { key: "copy-deeplink", commands: ["session.copyLink"] },
  { key: "copy-session-id", commands: ["session.copyID"] },
  { key: "copy-cwd", commands: ["app.copyDirectory"] },
  { key: "fork-chat", commands: ["session.fork"] },
  { key: "force-reload", commands: ["browser.forceReload"] },
  { key: "search", commands: ["app.search"] },
  { key: "reload-page", commands: ["browser.reload"] },
  { key: "search-files", commands: ["app.openFile"] },
  { key: "show-shortcuts", commands: ["app.shortcuts"] },
  ...Array.from({ length: 9 }, (_, at) => ({ key: "goto-chat", commands: [`tab.goto.${at + 1}`], n: at + 1 })),
  { key: "toggle-max-side", commands: ["panel.maximize"] },
]

export interface PageCommand {
  id: string
  title: string
  hint?: string
}

export interface ShownRow {
  id: string
  title: string
  desc: string
  hint?: string
}

/** The rows the page draws, in MiMo's order, with MiMo's words where the command is MiMo's. */
export function pageRows(
  commands: readonly PageCommand[],
  translate: (key: string, params?: Record<string, string | number>) => string,
): ShownRow[] {
  const byID = new Map(commands.map((command) => [command.id, command]))
  const rows: ShownRow[] = []
  for (const row of PAGE_ROWS) {
    const at = row.commands.findIndex((id) => byID.has(id))
    if (at < 0) continue
    const command = byID.get(row.commands[at])!
    const own = at === 0
    rows.push({
      id: command.id,
      hint: command.hint,
      title: own ? translate(`key.label.${row.key}`, row.n ? { n: row.n } : undefined) : command.title,
      desc: own && row.desc !== false ? translate(`key.desc.${row.key}`) : "",
    })
  }
  return rows
}
