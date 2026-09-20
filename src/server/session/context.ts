import path from "node:path"
import { attachmentKind, extensionOf } from "@shared/attachment-kind"
import { interfaceLocale, localeName } from "./locale"

/** Office documents a model cannot read as text, and what opens each of them. */
const OFFICE_TOOLS: Record<string, string> = {
  xlsx: "Python with openpyxl, or pandas when the sheet is a table",
  xlsm: "Python with openpyxl, or pandas when the sheet is a table",
  xlsb: "Python with pandas (its pyxlsb reader), or LibreOffice to convert it first",
  xls: "Python with pandas (its xlrd reader), or LibreOffice to convert it first",
  docx: "Python with python-docx",
  doc: "LibreOffice to convert it to .docx first, then python-docx",
  pptx: "Python with python-pptx",
  ppt: "LibreOffice to convert it to .pptx first, then python-pptx",
  pdf: "Python with pypdf for the text, or a page renderer when the layout matters",
  odt: "LibreOffice to convert it, or a reader for OpenDocument",
  ods: "Python with pandas, or LibreOffice to convert it",
  odp: "LibreOffice to convert it to .pptx first",
  rtf: "Pandoc or LibreOffice to convert it to plain text",
  epub: "Python with ebooklib, or Pandoc to convert it",
}

/** The one line every block ends on: the paths are exact, so nothing is to be searched for. */
const BY_PATH = "Work on the absolute paths exactly as written. Do not search the user's folders, do not glob, do not list directories to find these files, and do not ask for a path again."

/**
 * MiMo's attachment blocks: what the user attached this turn, sorted into the
 * three kinds that need different handling, each with the paths to work on.
 *
 * Only a picture travels inside the message. A text file, an Office document
 * and anything else are named here and nowhere else, so the model reads what it
 * needs, when it needs it, at the size it really is - an attached 300 KB log
 * used to arrive cut off at 50 KB under a line claiming the read had already
 * been made for it, and the rest was never fetched.
 *
 * Three blocks rather than one list because what to do differs entirely by
 * kind: the first is read with the read tool, the second needs a library named
 * per type, and the third is a path to operate on rather than a document to
 * read. A single list said none of that, so a spreadsheet read as text came
 * back as mojibake and the model reported the file as damaged.
 */
export function attachmentNote(files: readonly { path: string }[], directory: string): string | undefined {
  if (!files.length) return undefined
  const absolute = (file: { path: string }) => (path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path))
  const text: string[] = []
  const office: string[] = []
  const binary: string[] = []
  for (const file of files) {
    const target = absolute(file)
    const kind = attachmentKind(file.path)
    // A picture is in the message already; it needs no instructions.
    if (kind === "image") continue
    if (kind === "office") office.push(target)
    else if (kind === "text") text.push(target)
    else binary.push(target)
  }
  if (!text.length && !office.length && !binary.length) return undefined

  const lines = ["# Attached files", "The user attached these files to this message. Tell them in one sentence what you received before you do anything else."]
  const listed = (paths: readonly string[]) => paths.map((target) => `- ${target}`)
  if (text.length) {
    lines.push(
      "",
      "Text and code files. They are not in this message: read each one with the read tool before working on it.",
      ...listed(text),
      BY_PATH,
    )
  }
  if (office.length) {
    lines.push(
      "",
      "Office documents. They are binary: reading one with the read tool gives you the compressed container, not the content. Open each with what fits it:",
      ...office.map((target) => `- ${target} - ${OFFICE_TOOLS[extensionOf(target)] ?? "a reader that understands this format"}`),
    )
    // MiMo's bundled runtime: its Python already has these libraries (src/main/runtimes.ts names it).
    if (process.env.MCODE_PYTHON) lines.push("MCode's bundled Python (the MCODE_PYTHON environment variable) has openpyxl, pandas, python-docx, python-pptx and pypdf installed; run these with it.")
    else lines.push("Check that the library is installed before relying on it, and say so plainly if it is not rather than guessing at the contents.")
    lines.push(BY_PATH)
  }
  if (binary.length) {
    lines.push(
      "",
      "Files of a binary or unknown kind - audio, video, archives, images this model cannot read, anything else. Nothing of them is in this message: operate on each one directly, at its path, with whatever tool suits it.",
      ...listed(binary),
      BY_PATH,
    )
  }
  return lines.join("\n")
}

/**
 * What the model is told about where it is working, attached to the user's own
 * messages as they are sent - MiMo's runtime context, in MCode's words.
 *
 * Every prompt carries the reply language; the first prompt of a conversation
 * also carries the working directory and a note about what this app offers.
 * They are stored on the message, so what a message was sent with stays what
 * it was sent with, and the conversation's prefix does not shift under it.
 */

export interface RuntimeInput {
  /** The interface language setting; empty follows the machine. */
  language: string | undefined
  /** Given only on the conversation's first message. */
  directory?: string
  /** The date the message was sent, as YYYY-MM-DD. */
  today?: string
}

/**
 * MiMo's runtime context holds the working directory and the reply language
 * and nothing else - no branch, no working tree, no model name. MCode adds the
 * date, which no model can work out for itself; the repository block that used
 * to follow this one is gone (the user's 2026-09-20 decision).
 */
export function runtimeContext(input: RuntimeInput): string {
  const locale = interfaceLocale(input.language)
  const lines = ["# Runtime context"]
  if (input.directory) lines.push(`Working directory: ${input.directory}`)
  lines.push(
    `Response language: ${localeName(locale)}. Reply in this language unless the user's message or their custom instructions ask for another.`,
  )
  if (input.today) lines.push(`Today: ${input.today}`)
  return lines.join("\n")
}

export interface SessionNoteInput {
  /** The MCP servers this conversation has, by the name they are configured under. */
  mcpServers: string[]
  /** Where the user's global AGENTS.md lives. */
  globalAgentsFile: string
  /** This app's own config file, which holds the MCP servers among everything else. */
  configFile: string
  /** Where this app keeps its data, which is where a global skill goes. */
  dataRoot: string
  platform?: NodeJS.Platform
}

/**
 * The once-per-conversation note: which tools this app adds, where things are
 * configured, and how to ask.
 *
 * The MCP paragraph is the long one on purpose, and it is the one MiMo spends
 * its own length on. Without it a model that has a configured MCP server still
 * reaches for a platform's command-line tool, spends a turn on a login this app
 * cannot service, and then tells the user it cannot see any MCP servers at all.
 *
 * Mixed languages, because MiMo's are: of the six blocks it assembles here,
 * the MCP-config one and the environment-check guard are Chinese and the rest
 * English. That split is copied rather than tidied.
 */
export function sessionNote(input: SessionNoteInput): string {
  const platform = input.platform ?? process.platform
  const lines = ["# About this app"]

  if (input.mcpServers.length) {
    lines.push(
      `- MCP servers configured here: ${input.mcpServers.join(", ")}. This is the user's real configuration, so when they ask which servers they have, answer from this list rather than saying you cannot tell.`,
      "- Whether a server can be used this turn is a different question: it can when its tools are in the tool list you were given. Where they are, use them. Where a configured server's tools are missing, say it is configured but not loaded in this conversation - a server added or switched on applies to conversations started afterwards - instead of denying the server exists.",
      "- Prefer an MCP tool to a command-line program that does the same job. When a server covers the work, do not reach for that platform's CLI, do not check whether the CLI is installed, and never try to sign into one: this app cannot hand a terminal over to an interactive login, so the attempt only costs a turn.",
      "- A server's own executable is not a shell fallback either. If the tool you need is missing, say which server it belongs to and that it needs connecting, rather than running the server yourself or substituting a different server's tool.",
    )
  } else {
    lines.push("- No MCP servers are configured here. Say so plainly if the user asks, and do not invent one.")
  }

  /*
   * The configuration file is the one paragraph MiMo writes in Chinese among
   * these English ones (its `Jee()`), and MCode follows that split: the model
   * is being told a fact about this desktop, not given general guidance.
   */
  lines.push(
    `- [MCP 配置文件] MCP 服务器就落在 ${input.configFile} 的 \`mcpServers\` 段里。**这个文件确实存在,也可以直接编辑** —— 用户说「把这几个 MCP 装进来」时,不要回答「桌面没给配置文件入口、只能到设置里一个个加」,用文件工具读写这一段就能一次加完。每个服务器一项:本地的是 {"type":"local","command":["程序","参数"],"environment":{"KEY":"值"},"enabled":true},远程的是 {"type":"remote","url":"https://...","headers":{"KEY":"值"},"enabled":true}。只改 \`mcpServers\` 段,文件其余部分原样保留;改完要告诉用户,改动对之后新开的对话生效。设置里的 MCP 页也能用图形界面增删。`,
    `- A skill goes in <project>/.mcode/skills/<name>/SKILL.md for one project, or ${path.join(input.dataRoot, "skills")}/<name>/SKILL.md for every project. The folder name is the skill's id; its SKILL.md needs name and description in the frontmatter. A new skill is picked up by conversations started after it.`,
    `- Instructions: a project's own go in AGENTS.md at its root, and one in a nested folder is read as well for work under it. The user's global instructions are in ${input.globalAgentsFile}. Write to those paths when asked to record a rule; do not invent a folder for another tool's convention.`,
    "- When the user has to choose between options, ask with the question tool instead of listing the options in prose, and set multiple when more than one answer can apply - the flag, not the wording, is what lets them pick more than one.",
  )

  lines.push("", environmentGuard(platform))
  return lines.join("\n")
}

/**
 * The environment-check guard, once per conversation.
 *
 * In Chinese, as MiMo's two are (`guard-envcheck-win32.md` and its unix twin),
 * while the base prompt around it stays English - the user's 2026-09-20
 * decision. The words are MCode's own; the rules are the ones MiMo states,
 * because they answer the single most common failure of a coding agent on a
 * machine it has not seen: one bare `node -v` misses on PATH, the agent
 * declares the toolchain absent, quietly stops verifying anything, and reports
 * a reading of the code as if it had run it.
 *
 * The last two rules are not about paths at all and matter as much: finish the
 * check you announced inside this turn, and do not change your mind about it
 * from turn to turn.
 */
export function environmentGuard(platform: NodeJS.Platform): string {
  const shared = [
    "查到了就用全路径**把测试或构建真正跑起来**,而不是退回到只读代码、只做静态分析。",
    "还有两条与路径无关:你一旦说了要做某项检查(「我来跑一下类型检查」之类),就在**本回合内**做完再收尾,不要只宣布打算就停下;也不要在后续回合里反复改口、原地打转。",
    "只有照上面查过、确认真的没有,才可以说「本机缺少 X」。",
  ]
  if (platform === "win32") {
    return [
      "[环境检测] 本机是 **Windows**,不是 macOS 或 Linux,命令跑在 PowerShell 里。判断某个工具链(Node.js/npm/pnpm/yarn、Python/pip 等)在不在、装在哪里时,一律按 Windows 的方式来:",
      "- 不要用 `/bin/zsh`、`bash -lc`、`zsh -lc` 这类登录 shell,Windows 默认没有;也不要去找 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.nvm/...` 这些 Unix 路径,它们在这里不存在。",
      "- 不要只凭一条裸命令(比如 `node -v`)在当前 PATH 上失败,就断定「没装 / 跑不了测试或构建」。用 PowerShell 的 `Get-Command node` 或 `where.exe node` 去定位,不要用 `which`。",
      "- Node 常见的落脚处:`C:\\Program Files\\nodejs`、nvm-windows(`%APPDATA%\\nvm` 或 `%NVM_HOME%`)、fnm、volta(`%USERPROFILE%\\.volta\\bin`)、scoop(`%USERPROFILE%\\scoop\\shims`)、chocolatey(`C:\\ProgramData\\chocolatey\\bin`)。Python 常走 py 启动器、`%LOCALAPPDATA%\\Programs\\Python`,或者 conda/uv 的环境。",
      `- ${shared[0]}`,
      `- ${shared[1]}`,
      `- ${shared[2]}`,
      "写 PowerShell 而不是 bash:变量用 `$env:NAME`,带空格的路径用 `& \"路径\"` 调用,也不要假定 GNU 那套命令行工具在这里。",
    ].join("\n")
  }
  const unix = platform === "darwin" ? "macOS" : "Linux"
  return [
    `[环境检测] 本机是 **${unix}**,不是 Windows。判断某个工具链(Node.js/npm/pnpm/yarn、Python/pip 等)在不在、装在哪里时,一律按这个平台的方式来:`,
    "- 不要用 `where.exe`、`Get-Command` 或 `%APPDATA%` 这类 Windows 的写法,它们在这里没有意义。用 `command -v node`(或 `which node`)去定位。",
    "- 不要只凭一条裸命令(比如 `node -v`)在当前 PATH 上失败,就断定「没装 / 跑不了测试或构建」:非交互的 shell 读不到用户登录时才加载的那段 PATH。",
    platform === "darwin"
      ? "- Node 常见的落脚处:`/usr/local/bin`、`/opt/homebrew/bin`、nvm(`~/.nvm/versions/node/*/bin`)、fnm、volta(`~/.volta/bin`)、asdf(`~/.asdf/shims`)。Python 常走 `python3`、pyenv(`~/.pyenv/shims`)、Homebrew,或者 conda/uv 的环境。"
      : "- Node 常见的落脚处:`/usr/local/bin`、`/usr/bin`、nvm(`~/.nvm/versions/node/*/bin`)、fnm、volta(`~/.volta/bin`)、asdf(`~/.asdf/shims`)。Python 常走 `python3`、pyenv(`~/.pyenv/shims`),或者 conda/uv 的环境。",
    `- ${shared[0]}`,
    `- ${shared[1]}`,
    `- ${shared[2]}`,
  ].join("\n")
}
