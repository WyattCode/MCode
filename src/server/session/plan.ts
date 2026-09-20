import path from "node:path"
import { ToolError, type ToolContext } from "../tool/types"

/**
 * Plan mode's file and the notes that go with it.
 *
 * MiMo's plan agent is not a smaller tool set: it keeps every tool and is held
 * to reading by one hard rule - writes are refused everywhere but its plan
 * file - and by a reminder on each of its turns. The plan itself is an ordinary
 * markdown file in the project, so the user can open it, keep it, and read it
 * after the conversation is gone.
 *
 * MiMo writes it to `<worktree>/.mimocode/plans/<created>-<slug>.md` while the
 * project is under version control and to `<data>/plans/<created>-<slug>.md`
 * when it is not; this app puts the same two folders at `<project>/.mcode/plans`
 * and `<app data>/plans`. Both are writable while planning, as MiMo allows both.
 */

export const PLANS_FOLDER = "plans"

/*
 * A conversation's two-word slug, this app's own words. MiMo names its plan
 * files from a slug of the same shape, which is what keeps a plan folder
 * readable: a row of `1758...-ses_019a....md` tells nobody anything.
 */
const SLUG_FIRST = [
  "amber", "brisk", "bright", "candid", "clear", "deft", "even", "fair", "fleet", "frank",
  "keen", "level", "lithe", "mellow", "neat", "patient", "plain", "prompt", "ready", "sound",
  "spare", "steady", "sturdy", "supple", "terse", "trim", "upright", "vivid", "warm", "willing",
]

const SLUG_SECOND = [
  "anchor", "arbour", "beacon", "bridge", "burrow", "compass", "cove", "ember", "ferry", "furnace",
  "harvest", "hollow", "kettle", "lantern", "ledger", "loom", "mill", "orchard", "quarry", "ridge",
  "sextant", "shuttle", "signal", "spindle", "thicket", "trellis", "vessel", "wharf", "willow", "workshop",
]

/** A fresh slug for a new conversation. */
export function newSlug(): string {
  const pick = (words: readonly string[]) => words[Math.floor(Math.random() * words.length)]!
  return `${pick(SLUG_FIRST)}-${pick(SLUG_SECOND)}`
}

/** The slug a conversation's plan file is named from; one stored before slugs existed is named by its id. */
export function slugOf(session: { id: string; slug?: string }): string {
  return session.slug?.trim() || session.id
}

export interface PlanPlace {
  /** The project this conversation works in. */
  directory: string
  /** Where the app keeps its own files, for a project that is not a repository. */
  dataRoot: string
  /** Whether the project is under version control, which is what decides where the plan lives. */
  repo: boolean
}

/** The folders a plan may be written in: the project's own, and the app's. */
export function planFolders(place: PlanPlace): string[] {
  return [path.join(path.resolve(place.directory), ".mcode", PLANS_FOLDER), path.join(path.resolve(place.dataRoot), PLANS_FOLDER)]
}

/**
 * Where this conversation's plan is written.
 *
 * Named from when the conversation started and from its slug, both fixed for
 * its lifetime, so every turn of it finds the same file.
 */
export function planFile(place: PlanPlace, session: { created: number; slug: string }): string {
  const folder = place.repo ? planFolders(place)[0]! : planFolders(place)[1]!
  return path.join(folder, `${session.created}-${session.slug}.md`)
}

/** The plan's path as the user sees it: inside the project, relative to it; anywhere else, in full. */
export function planDisplay(directory: string, file: string): string {
  const relative = path.relative(path.resolve(directory), path.resolve(file))
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file
}

/** Whether a path may be written while planning: a markdown file in one of the plan folders. */
export function planWritable(target: string, folders: readonly string[]): boolean {
  const file = path.resolve(target)
  if (!file.toLowerCase().endsWith(".md")) return false
  return folders.some((folder) => {
    const relative = path.relative(path.resolve(folder), file)
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

/**
 * plan: the agent a subagent runs as.
 *
 * An explore subagent only ever reads. Anything else builds - even when the
 * conversation that started it is still planning, because a subagent is an
 * agent of its own rather than a continuation of the planning turn, as MiMo's
 * are (the user's 2026-09-16 decision).
 */
export function subagentAgent(type: "general" | "explore"): "plan" | "build" {
  return type === "explore" ? "plan" : "build"
}

/** What a write outside the plan file is refused with. The model reads it, so it says what to do instead. */
export function planRefusal(display: string, plan: string): string {
  return (
    `Refused: plan mode is on, so ${display} was not written and nothing changed. ` +
    `The only file you may write is the plan at ${plan}. ` +
    `Put what you wanted to change into the plan instead, and call plan_exit when the plan is ready.`
  )
}

/**
 * The same refusal, for a write made in the step in which the plan was
 * approved - a call beside plan_exit in the same reply.
 *
 * It says what the plain one cannot: nothing is wrong, the switch has
 * happened, and this step is simply the wrong side of it. Without this a real
 * model reads "plan mode is on" moments after being told the plan was
 * approved, and decides the switch failed.
 */
export function planApprovedRefusal(display: string): string {
  return (
    `Refused for this step only: ${display} was not written and nothing changed. ` +
    `The plan is approved and this conversation is in build mode, which starts with your next step. ` +
    `Do not call plan_exit again. Make this change again in your next step, and carry on with the plan.`
  )
}

/**
 * The check every write tool makes before it changes anything.
 *
 * Refused here rather than by a question, as MiMo refuses it outright: a
 * planning turn that could ask its way out of being read-only would not be
 * read-only, and the user would be answering for a promise the app made.
 */
export function guardPlanWrite(context: ToolContext, target: string, display: string): void {
  const plan = context.plan
  if (!plan || plan.agent !== "plan" || plan.writable(target)) return
  const shown = planDisplay(context.directory, plan.file)
  if (plan.switched) throw new ToolError(planApprovedRefusal(display), "tool.err.planApproved", { path: display, plan: shown })
  throw new ToolError(planRefusal(display, shown), "tool.err.planOnly", { path: display, plan: shown })
}

/**
 * The note a conversation's first planning turn carries.
 *
 * Long on purpose, and in this app's own words: it has to say what planning
 * allows, what it refuses before the model tries it, and how a planning turn
 * is meant to end, or the model spends turns asking for approvals that are
 * already refused.
 *
 * Chinese, as MiMo's per-turn plan guard is - its base prompt is English and
 * every guard appended around it is Chinese, whatever the interface language
 * (the user's 2026-09-20 decision). It states MiMo's rules and then MCode's
 * own, which the plan file and plan_exit need and MiMo has no equivalent for.
 */
export function firstPlanNote(plan: string, exists: boolean): string {
  return [
    "[计划模式] 用户开启了计划模式:这个任务现在只研究、只设计,还不要落地。本条的效力高于任何相反的指示。",
    "",
    "可以做什么",
    "- 想看多少就看多少:read、glob、grep 是查看项目的正途,也可以派子智能体分头去看不同的部分。",
    "- bash 可用,照常走权限规则,但只用于你确信不会改变任何东西的命令 —— git status、git log、git diff、列出已安装的包之类。",
    "",
    "不要做什么",
    "- 除下面那个方案文件外,不要新建或修改任何文件。写到别处会在执行前被直接拒绝,所以既不要去试,也不要请用户批准。",
    "- 不要跑测试、lint、类型检查、构建或同类的项目命令。它们默认并不安全:lint 可能配了 --fix,测试可能写快照或动数据库,构建会产出文件。唯一的例外,是你已经读过其配置、确知不会改动任何东西的命令。",
    "- 不要提交、推送、安装或卸载依赖,也不要改动任何配置。",
    "- 当你发现「得改点什么才能往下走」时,把这件事写进方案里,然后继续看代码。",
    "",
    "方案文件",
    exists ? `- ${plan} 已经写了一份方案。先读它,再随着思路的推进去修改它。` : `- 目前还没有方案文件。用 write 工具把你的方案写到 ${plan}。`,
    "- 它是你唯一可以写的文件。边想边往里写,不要把全部内容留到最后一次性产出。",
    "",
    "怎么推进",
    "1. 弄清需求。读它涉及的代码。查看的活派给 explore 子智能体 —— 最多三个,在同一步里一起发起,通常一个就够;只有在范围确实不清楚、或牵扯到项目的好几个部分时才用更多,并且给每个划定各自的范围,免得重复读同样的文件。然后在动手设计之前,用 question 工具把还含糊的地方问清楚。",
    "2. 设计方案。至多派一个 general 子智能体,让它基于第 1 步的发现把做法想出来;改动小到设计一望即知时就跳过这步。它的提示词必须把背景带上 —— 文件路径、你追踪到的调用链、约束条件,以及用户到底要什么 —— 因为它一开始什么都不知道。它给回来的是建议,不是决定。",
    "3. 复核手上的东西。子智能体说关键的那些文件,你自己读一遍,不要只信它的转述;拿方案去对照用户真正的要求,而不是对照「做起来有意思的东西」;还有拿不准的地方就问用户。",
    "4. 把定稿写进方案文件:你推荐的做法(不要罗列你已经否掉的备选)、会改动的文件路径、工作的先后顺序,以及一节验证说明 —— 别人要怎样从头到尾验一遍:跑哪些命令、跑哪些测试、应该看到什么。短到能一眼扫完,全到能照着做。",
    "5. 调用 plan_exit。",
    "",
    "本回合只能以两种方式收尾,没有第三种:用 question 工具问出你需要知道的事;或者 —— 方案已经写好、也没有要问的了 —— 调用 plan_exit 把它交给用户批准。不要用 question 工具去问「这个方案行不行」,那是 plan_exit 的职责。",
  ].join("\n")
}

/** Every later planning turn: the same rules in one line. */
export function laterPlanNote(plan: string): string {
  return `[计划模式] 计划模式仍然开着:只读,且 ${plan} 是你唯一可以写的文件。不要开始实现。本回合用 question 工具或 plan_exit 收尾。`
}

/** The note on the first turn after the conversation leaves plan mode. */
export function buildSwitchNote(): string {
  return "This conversation has changed from plan mode to build mode. You are no longer read-only: you may change files, run commands and use every tool as usual."
}

/** Added to that note when a plan was actually written. */
export function carryOutNote(plan: string): string {
  return `A plan is written at ${plan}. Carry out what it describes.`
}

/** What the conversation is told when the user approves the plan, in place of a message they would have typed. */
export function approvedNote(plan: string): string {
  return `The plan at ${plan} is approved. You are in build mode now and may change files; carry the plan out.`
}
