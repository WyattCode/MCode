/**
 * Round 16 (lane B): the model-facing layer becomes MiMo's.
 *
 * What is asserted here is the shape of what the model is actually sent - the
 * language each layer is written in, the guards that ride on a turn, and the
 * detectors that watch a turn for a loop. Kept apart from smoke.ts the way the
 * earlier rounds are; smoke.ts calls `roundSixteenPromptChecks` with its own
 * check and section.
 *
 * Nothing here reads the user's profile, calls a model or reaches the network.
 */
import type { Check } from "./smoke-round5"
import { environmentGuard, sessionNote } from "../src/server/session/context"
import { firstPlanNote, laterPlanNote, buildSwitchNote } from "../src/server/session/plan"
import { PLAN_SECTION, agentPrompt } from "../src/server/session/prompts"

/** Any Han character: what tells a Chinese layer from an English one. */
const CJK = /[\u4e00-\u9fff]/

export async function roundSixteenPromptChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 16 (R16-B2): the guards are Chinese and the base layers are not, as MiMo splits them")
  {
    /*
     * MiMo ships its prompts as plain files: `claude.txt` and `desktop-base.md`
     * are English, and every guard appended around them - plan, goal,
     * environment check - is Chinese, for every user in every locale. This is
     * that split, asserted from both sides so neither can drift.
     */
    const build = agentPrompt("build")
    check("the two base layers are English", !CJK.test(build), build.slice(0, 120))
    check("the plan-mode addendum is Chinese", CJK.test(PLAN_SECTION) && PLAN_SECTION.startsWith("# \u8ba1\u5212\u6a21\u5f0f"), PLAN_SECTION.slice(0, 40))
    check(
      "and it still states every rule MiMo's states",
      ["\u5206\u6b65\u65b9\u6848", "write\u3001edit\u3001bash", "`task` \u5de5\u5177", "plan_exit"].filter((part) => !PLAN_SECTION.includes(part)),
      [],
    )

    const first = firstPlanNote("/p/.mcode/plans/x.md", false)
    const later = laterPlanNote("/p/.mcode/plans/x.md")
    check("the per-turn plan guard is Chinese and marked as MiMo marks it", CJK.test(first) && first.startsWith("[\u8ba1\u5212\u6a21\u5f0f]") && later.startsWith("[\u8ba1\u5212\u6a21\u5f0f]"), first.slice(0, 40))
    check("both name the plan file, which is what the turn may write", first.includes("/p/.mcode/plans/x.md") && later.includes("/p/.mcode/plans/x.md"))
    /*
     * The switch out of plan mode is English in MiMo too (`build-switch.txt`,
     * from the engine rather than the desktop), so a conversation really does
     * read a Chinese guard and then an English switch.
     */
    check("the switch back to build stays English, as MiMo's does", !CJK.test(buildSwitchNote()), buildSwitchNote())
  }

  section("Round 16 (R16-B3): the environment-check guard, once per conversation")
  {
    /*
     * MiMo's answer to the commonest failure of a coding agent on an unfamiliar
     * machine: one bare `node -v` misses on PATH, the agent announces the
     * toolchain is absent, stops verifying, and hands back a reading of the
     * code as though it had run it. Both platforms carry the rule, and each
     * names where that platform actually keeps its toolchains.
     */
    const windows = environmentGuard("win32")
    const mac = environmentGuard("darwin")
    const linux = environmentGuard("linux")

    for (const [name, guard] of [["windows", windows], ["macOS", mac], ["Linux", linux]] as const) {
      check(`${name}: the guard is Chinese and marked`, CJK.test(guard) && guard.startsWith("[\u73af\u5883\u68c0\u6d4b]"), guard.slice(0, 30))
      check(`${name}: one failed probe is not a verdict`, guard.includes("node -v") && guard.includes("\u5c31\u65ad\u5b9a\u300c\u6ca1\u88c5"), guard.slice(0, 400))
      check(`${name}: the full path is then used to really run the tests`, guard.includes("\u771f\u6b63\u8dd1\u8d77\u6765") && guard.includes("\u9759\u6001\u5206\u6790"))
      check(`${name}: a promised check is finished inside this turn`, guard.includes("**\u672c\u56de\u5408\u5185**"))
      check(`${name}: and only then may it say something is missing`, guard.includes("\u672c\u673a\u7f3a\u5c11 X"))
    }

    check("windows looks where Windows keeps Node", ["C:\\\\Program Files\\\\nodejs", "%APPDATA%\\\\nvm", "volta", "scoop", "chocolatey"].filter((place) => !windows.includes(place)), [])
    check("and names PowerShell's own way of looking", windows.includes("Get-Command node") && windows.includes("where.exe node") && windows.includes("\u4e0d\u8981\u7528 `which`"))
    check("it warns off the Unix shells and paths that are not there", ["bash -lc", "/usr/local/bin", "~/.nvm/...", "/opt/homebrew/bin"].filter((place) => !windows.includes(place)), [])

    check("a Unix machine gets the mirror image", mac.includes("command -v node") && mac.includes("不要用 `where.exe`"), mac.slice(0, 200))
    check("macOS names Homebrew's prefix and Linux does not", mac.includes("/opt/homebrew/bin") && !linux.includes("/opt/homebrew/bin"))
    check("and each names itself rather than the other", mac.includes("macOS") && linux.includes("Linux") && !linux.includes("macOS"))

    const note = sessionNote({ mcpServers: [], globalAgentsFile: "/g/AGENTS.md", configFile: "/g/config.json", dataRoot: "/g", platform: "win32" })
    check("the guard rides on the once-per-conversation note", note.includes("[\u73af\u5883\u68c0\u6d4b]") && note.includes("Get-Command node"), note.slice(-300))
    check("beside the MCP config paragraph, the other one MiMo writes in Chinese", note.includes("[MCP \u914d\u7f6e\u6587\u4ef6]"))
    check("while the paragraphs MiMo keeps English stay English", note.includes("A skill goes in <project>/.mcode/skills/") && note.includes("When the user has to choose between options"))
  }
}
