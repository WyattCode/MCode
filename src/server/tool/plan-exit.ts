import type { ToolDefinition } from "./types"
import { planDisplay } from "../session/plan"

/**
 * Asking the user to approve a plan, and with it to leave plan mode.
 *
 * The one way out of planning that the model has. It puts a Yes/No card in
 * the dock - the same card the question tool raises, tagged with the plan file
 * so the window can name it and offer to open it - and on Yes the conversation
 * becomes a building one and is told, in place of a message the user would
 * have typed, that the plan is approved. On No, or on anything the user types
 * instead, planning carries on with what they said.
 *
 * It is offered in build mode too, as MiMo offers it in both, and says plainly
 * that it does nothing there rather than failing: a model that calls it after
 * the switch has already got what it wanted.
 */
export const PlanExitTool: ToolDefinition = {
  name: "plan_exit",
  description: [
    "Ask the user to approve the plan you have written and switch this conversation from plan mode to build mode.",
    "Call it once the plan file holds the whole plan and nothing is left for you to ask.",
    "Do not call it before the plan is written, while a question of yours is unanswered, or when the user has said they want to keep planning.",
    "It raises a Yes/No card: Yes switches to build mode and you carry the plan out, No or typed feedback leaves you planning, and the feedback says what to change.",
    "In build mode it does nothing.",
  ].join(" "),
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, context) {
    const plan = context.plan
    if (!plan || plan.agent !== "plan") {
      return {
        title: "Not planning",
        output: "This conversation is not in plan mode, so there is nothing to leave. Carry on with the work.",
        metadata: { switched: false },
      }
    }

    const display = planDisplay(context.directory, plan.file)
    const questions = [
      {
        question: `The plan at ${display} is finished. Switch to build mode and start carrying it out?`,
        header: "Plan",
        options: [
          { label: "Yes", description: "Switch to build mode and start carrying out the plan" },
          { label: "No", description: "Stay in plan mode and keep working on the plan" },
        ],
        plan: display,
      },
    ]
    const answers = await context.questions.ask({
      sessionID: context.sessionID,
      questions,
      tool: { messageID: context.messageID, callID: context.callID },
      signal: context.signal,
    })
    /*
     * Kept on the part as the question tool keeps its own, because the card in
     * the transcript is redrawn from the stored call: plan_exit carries no
     * questions in its input, so without this an answered card would come back
     * from a reload with nothing to show.
     */
    const metadata = (extra: Record<string, unknown>) => ({ questions, answers, ...extra })
    const chosen = (answers[0] ?? []).map((entry) => entry.trim()).filter(Boolean)

    if (chosen.includes("Yes")) {
      await plan.approve()
      return {
        title: "Switching to build mode",
        output: "The user approved the plan. This conversation is in build mode now; wait for what they say next.",
        metadata: metadata({ switched: true }),
      }
    }

    // Anything typed instead of an answer is feedback about the plan, as MiMo reads it.
    const feedback = chosen.find((entry) => entry !== "No" && entry !== "Yes")
    if (feedback) {
      return {
        title: "Feedback on the plan",
        output: [
          `The user did not approve the plan yet and said: ${feedback}`,
          "",
          "Plan mode is still on - do not start implementing. Work their feedback into the plan file, then call plan_exit again when it is ready.",
        ].join("\n"),
        metadata: metadata({ switched: false, feedback }),
      }
    }

    return {
      title: "Still planning",
      output: [
        "The user chose to keep planning.",
        "Plan mode is still on - do not start implementing. Ask with the question tool which parts of the plan they want changed, work their answers into the plan file, and call plan_exit again when it is ready.",
      ].join(" "),
      metadata: metadata({ switched: false }),
    }
  },
}
