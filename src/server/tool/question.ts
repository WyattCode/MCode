import type { QuestionAnswer, QuestionPrompt, QuestionRequest } from "@shared/protocol"
import { Identifier } from "@shared/id"
import type { Bus } from "../bus"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * The questions a turn is parked on.
 *
 * A transcription of the reference's `@opencode/Question` service
 * (node-BBwF64dM.js @22136889): a map of request id to a deferred, `ask`
 * publishing `Asked` and awaiting it, `reply` and `reject` settling it and
 * publishing `Replied` / `Rejected`, and `list` handing back everything still
 * parked. It is deliberately shaped like `Permissions` in this app, because it
 * is the same problem twice - a tool that cannot finish until a person answers
 * - and the two have to behave the same way when a window reloads or a turn is
 * stopped.
 *
 * Nothing is written to disk. A question that outlived the process would be a
 * question whose tool call is gone, so there would be nothing to answer.
 */
export class Questions {
  private readonly pending = new Map<
    string,
    { request: QuestionRequest; resolve: (answers: QuestionAnswer[]) => void; reject: (reason: Error) => void }
  >()

  constructor(private readonly bus: Bus) {}

  /**
   * Parks the calling tool until the reader answers.
   *
   * The abort signal is taken because a turn can be stopped while the form is
   * on screen. The reference gets this from its Effect fiber being interrupted;
   * here it has to be wired by hand, and without it Stop would leave the
   * promise unsettled and the session busy forever.
   */
  ask(input: {
    sessionID: string
    questions: QuestionPrompt[]
    tool?: { messageID: string; callID: string }
    signal?: AbortSignal
    /** The runner's repeated-call check, drawn by the window in its own words. */
    loop?: QuestionRequest["loop"]
  }): Promise<QuestionAnswer[]> {
    const request: QuestionRequest = {
      id: Identifier.request(),
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
      time: Date.now(),
      ...(input.loop ? { loop: input.loop } : {}),
    }

    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      /*
       * Asked after the turn was already stopped.
       *
       * An AbortSignal that has already fired does not fire again for a
       * listener added afterwards, so the one below would never run and this
       * promise would never settle - the turn would sit parked with a form on
       * screen asking the reader to answer something they had just stopped.
       * The window is real: runTool awaits a permission check before calling
       * execute, and Stop can land inside it.
       */
      if (input.signal?.aborted) {
        reject(dismissed())
        return
      }

      const settle = () => {
        this.pending.delete(request.id)
        input.signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        settle()
        this.bus.publish({ type: "question.rejected", sessionID: request.sessionID, requestID: request.id })
        reject(dismissed())
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })

      this.pending.set(request.id, {
        request,
        resolve: (answers) => {
          settle()
          resolve(answers)
        },
        reject: (reason) => {
          settle()
          reject(reason)
        },
      })
      this.bus.publish({ type: "question.asked", request })
    })
  }

  /**
   * Answers a parked question, which lets its turn continue.
   *
   * Answers are copied rather than stored by reference - the reference does the
   * same (`input.answers.map((a) => [...a])`) - because the array then travels
   * both to the model and into the part's metadata, and one of those two
   * mutating the other would be untraceable.
   */
  reply(requestID: string, answers: QuestionAnswer[]): boolean {
    const parked = this.pending.get(requestID)
    if (!parked) return false
    const copied = answers.map((answer) => [...answer])
    this.bus.publish({
      type: "question.replied",
      sessionID: parked.request.sessionID,
      requestID,
      answers: copied,
    })
    parked.resolve(copied)
    return true
  }

  /**
   * Refuses a question outright. The turn sees the reference's own refusal message.
   *
   * The dock's X does not come here: MiMo's dismiss replies with empty answers,
   * so the call completes as "Unanswered". This is left for Stop and abort.
   */
  reject(requestID: string): boolean {
    const parked = this.pending.get(requestID)
    if (!parked) return false
    this.bus.publish({ type: "question.rejected", sessionID: parked.request.sessionID, requestID })
    parked.reject(dismissed())
    return true
  }

  /** Dismisses everything a session is parked on - used when a turn aborts. */
  rejectAll(sessionID: string): void {
    for (const [id, parked] of [...this.pending]) {
      if (parked.request.sessionID !== sessionID) continue
      this.reject(id)
    }
  }

  /**
   * Every question still waiting on an answer, across every session.
   *
   * `question.asked` goes out once. A window that reloaded, or one opened
   * afterwards, has no other way to learn that a turn is parked - it would show
   * a busy session with nothing on screen to explain it, exactly the defect
   * `session.list` replaying `permissions.outstanding()` was written to fix.
   * The reference's counterpart is `GET /question`, "Get all pending question
   * requests across all sessions".
   */
  outstanding(): QuestionRequest[] {
    return [...this.pending.values()].map((parked) => parked.request)
  }
}

/**
 * What a dismissed question tells the model.
 *
 * Verbatim from the reference's `RejectedError.message` (@22138500). It goes
 * back as a tool error, which is this app's equivalent of the reference failing
 * the deferred: the model reads it, sees the question was refused rather than
 * answered, and carries on.
 */
const DISMISSED = "The user dismissed this question"

/*
 * Carries a code as well as the model's sentence, so the transcript can tell a
 * stopped question from a broken one without reading English.
 */
export const QUESTION_DISMISSED = "question.dismissed"

function dismissed(): ToolError {
  return new ToolError(DISMISSED, QUESTION_DISMISSED)
}

/**
 * The description handed to the model, verbatim.
 *
 * Copied character for character from `question_default`
 * (node-BBwF64dM.js @22911725), including the CRLF line endings the reference
 * actually sends - that is the copy the desktop tool registry loads
 * (`question2 = yield* QuestionTool` @32844286). A second, byte-different copy
 * of the same prose exists at @19448700 with LF endings and a permission
 * assertion around it; that one belongs to the v2 tool registry, which the
 * desktop builtin list does not use.
 *
 * The last three lines are the load-bearing part: they are what stops the model
 * writing its own "Other" option, because the client adds one.
 */
const DESCRIPTION = [
  "Put a decision to the user as a card of options, instead of writing the options out in your reply and waiting.",
  "The turn stops here until they answer, so ask only about things you genuinely cannot settle yourself.",
  "",
  "When to use it",
  "- The choice is the user's to make: which of two designs to build, which file is the right one, whether to change something you were not asked to change.",
  "- The task is ambiguous in a way that changes what you would do, and reading the project would not resolve it.",
  "- You are about to do something with consequences the user may not want.",
  "Do not use it for anything you can find out by reading the project, and do not ask the user to confirm work they already asked for.",
  "",
  "Writing the options",
  "- Keep each label to a few words; put the detail in its description, not in the label.",
  '- Do not add an "Other", "Something else" or "None of these" option. The window already adds a "type your own answer" row unless custom is false, so writing one yourself gives the user the same choice twice.',
  '- If one option is the one you would pick, make it the first and end its label with "(Recommended)".',
  "- The multiple flag, not the wording of the question, is what lets the user pick more than one. A question that reads as multi-choice but leaves multiple unset still accepts exactly one answer.",
  "",
  "You may ask several questions in one call; the user is walked through them one at a time. The answer comes back as the labels they chose, or as their own text when they typed it. A question the user skips comes back empty - take that as no preference and carry on rather than asking again.",
].join("\n")

/** What the model may hand over, checked before anyone is shown it. */
function readQuestions(raw: unknown): QuestionPrompt[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolError("questions must be a non-empty array")
  }
  return raw.map((entry, index) => {
    const item = entry as Partial<QuestionPrompt>
    const question = typeof item?.question === "string" ? item.question.trim() : ""
    if (!question) throw new ToolError(`questions[${index}].question is required`)
    const options = Array.isArray(item.options) ? item.options : []
    if (options.length === 0) throw new ToolError(`questions[${index}].options must not be empty`)
    return {
      question,
      header: typeof item.header === "string" ? item.header : "",
      options: options.map((option) => ({
        label: String((option as { label?: unknown })?.label ?? ""),
        description: String((option as { description?: unknown })?.description ?? ""),
      })),
      multiple: item.multiple === true,
      custom: item.custom,
    }
  })
}

/**
 * The tool the model calls to put a question to the reader.
 *
 * On by default, with no setting behind it: the reference's registry decides
 * with `["app","cli","desktop"].includes(flags.client) || flags.enableQuestionTool`
 * (@32848445), and the desktop client is in that list.
 *
 * It declares no permission bucket. The reference does assert one
 * (`permission.assert({action:"question"})`), but ships no
 * `settings.permissions.tool.question.title` or `.description` in any of its
 * eighteen languages, so that row is not one a reader ever sees and a bucket
 * here could only carry an invented name. See the report: this is a known
 * behaviour gap, chosen over a made-up string.
 */
export const QuestionTool: ToolDefinition = {
  name: "question",
  description: DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        // The reference's own annotation on the schema field.
        description: "Questions to ask",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "Complete question" },
            header: { type: "string", description: "Very short label (max 30 chars)" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Display text (1-5 words, concise)" },
                  description: { type: "string", description: "Explanation of choice" },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiple: { type: "boolean", description: "Allow selecting multiple choices" },
          },
          required: ["question", "header", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  async execute(input, context) {
    // A subagent cannot put questions to the user, as MiMo's cannot; it is not offered the tool, and a call that reaches here anyway is refused.
    if (context.subagent) throw new ToolError("A subagent cannot ask the user questions. Decide for yourself, or say in your final message what needs the user's decision.")
    const questions = readQuestions(input.questions)
    const answers = await context.questions.ask({
      sessionID: context.sessionID,
      questions,
      /*
       * Which call raised the question. The reference makes this optional
       * because a plugin can drive the same service with no tool call behind
       * it; a call from here always has one, and the client needs it to draw
       * the form against the right card.
       */
      tool: { messageID: context.messageID, callID: context.callID },
      signal: context.signal,
    })

    /*
     * The model-facing wording is the reference's `toModelOutput5` verbatim
     * (@19449900), down to the word `Unanswered` for a question the reader
     * skipped and the trailing sentence that tells the model to carry on.
     */
    const formatted = questions
      .map((entry, index) => {
        const answer = answers[index]
        return `"${entry.question}"="${answer?.length ? answer.join(", ") : "Unanswered"}"`
      })
      .join(", ")

    return {
      title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      /*
       * Stored on the part, which is what lets an answered card redraw itself
       * from the transcript with no live request behind it - the reference's
       * renderer reads exactly `props.metadata.answers`.
       */
      metadata: { answers },
    }
  },
}
