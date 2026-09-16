import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * MiMo's spoken progress, as a tool the model calls.
 *
 * MiMo's 语音反馈 setting tells the agent the reader wants to be kept up to date
 * by ear, and its engine says it with a cloud `tts_speech` call. This app speaks
 * with the machine's own voice instead - the window's speech synthesis, through
 * `lib/voice.ts` - so a line said here never leaves the computer and no service
 * is asked anything.
 *
 * It is offered only while the setting is on (the runner builds the turn's tool
 * list that way), which is also how the model learns it may speak at all. MiMo
 * instead keeps the tool in every turn and refuses the call when the setting is
 * off; a tool that is simply absent costs the model nothing to not call.
 */

/** As long a line as the window will speak; anything past this would be cut off mid-sentence. */
export const SPEAK_LIMIT = 240

export const SpeakTool: ToolDefinition = {
  name: "speak",
  description: [
    "Say one short line aloud on the user's machine, in MCode's own voice.",
    "The user has asked to be kept up to date by ear, so use this to report progress as you work: what you have just finished, what you are starting next, and that the task is done at the end.",
    "One plain sentence. No markup, no code, no file paths, no lists - it is heard rather than read. Say it in the language the user is writing in.",
    "It tells you nothing back and changes nothing on disk, so carry straight on with the work in the same turn.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The line to say: one short sentence, worded as it should be heard" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(input) {
    const line = typeof input.text === "string" ? input.text.trim() : ""
    if (!line) throw new ToolError("speak needs the line to say.")
    // The window speaks what the completed call carries; the result only reports what was said.
    const spoken = line.slice(0, SPEAK_LIMIT)
    return { output: `Said aloud: ${spoken}`, title: spoken, metadata: { text: spoken } }
  },
}
