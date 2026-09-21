/**
 * Round 20, the coding agent against MiMo 26.920's engine: tool advice MiMo
 * gives and MCode lacked, the prompt's examples, the first-message note, and
 * the request on the step that has to be the last one. Each check fails on the
 * text or the request as it stood before.
 *
 * smoke.ts calls `roundTwentyAgentChecks` with its own check and section.
 */
import { findTool } from "../src/server/tool/registry"
import type { Check } from "./smoke-round5"

const describe = (name: string) => findTool(name)?.description ?? ""

export async function roundTwentyAgentChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 20 (V4-1): read points at grep and glob, and keeps its byte cap for the notice")
  {
    const read = describe("read")
    check("V4-1: a large file or one with long lines is searched with grep", /large file/.test(read) && /lines run very long/.test(read) && read.includes("grep"), read)
    check("V4-1: an uncertain path is found with glob first", /not sure of a path/.test(read) && read.includes("glob first"), read)
    check("V4-1: the 50 KB cap is not stated up front", !read.includes("50 KB"), read)
    check("V4-1: it still says a read that stops early says where to go on", read.includes("says where to continue from"), read)
  }
}
