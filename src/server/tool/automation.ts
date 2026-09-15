import { AUTOMATION_MODES, NOTIFICATIONS, REASONING, RUN_MODES, automationService } from "../automation/service"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * automation: MiMo desktop's `automation_update`, the model's way to manage
 * scheduled tasks, in this app's own words. The work is the backend's
 * `AutomationService`; this only hands the call over.
 */
export const AutomationUpdateTool: ToolDefinition = {
  name: "automation_update",
  description: [
    "Create or manage scheduled tasks: a saved prompt that runs on a schedule, in a new conversation each time or in one existing conversation. Only from a conversation's own turn, never from a subagent.",
    "Use it when the user explicitly asks to create, change, pause, resume or delete scheduled work. When they already gave the task and the timing, do not ask again. Turn the timing into an RRULE yourself and never show the rule to the user.",
    "Before create, list the tasks and compare whole configurations, not only titles; view one that may match. Change an existing task instead of creating a near copy.",
    "mode: list, view (id), create (title, prompt, rrule), update (id, only the fields to change), pause / resume (id), delete (id).",
    "rrule: a whole line starting with RRULE:, in local time. FREQ is HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY; also INTERVAL, BYHOUR, BYMINUTE, BYDAY (SU,MO,TU,WE,TH,FR,SA), BYMONTH, BYMONTHDAY, WKST, COUNT, UNTIL. WEEKLY needs BYDAY, MONTHLY needs BYMONTHDAY, YEARLY needs BYMONTH and BYMONTHDAY; COUNT needs a DTSTART:YYYYMMDDTHHMM line and cannot go with UNTIL. Every day at 11:05 is RRULE:FREQ=DAILY;BYHOUR=11;BYMINUTE=5; weekdays at 09:00 is RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0. If a rule is refused, fix it and call again; do not switch to cron.",
    "prompt: what each run should do or say, with the user's constraints on wording and format; no timing, notification or scheduling words in it.",
    "runMode: new-task (default) opens a new conversation for every run; existing-task runs in targetThreadId, which defaults to this conversation. project: context (this conversation's project, the default) or none. model: a connected model id (provider/model when two providers share one); reasoning: low, medium, high, xhigh or max; both default to this conversation's.",
    "notification: all-runs, important-updates (only runs in an existing conversation that reply) or failed-runs; new-task defaults to all-runs, existing-task to important-updates. status: active or paused, for create and update; prefer pause and resume for one task.",
    "operationId: an id for this change, so a retried identical call is not applied twice; new for every different change. Ids of tasks come from list or view; never make one up.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...AUTOMATION_MODES], description: "What to do" },
      operationId: { type: "string", description: "An id for this change, reused only to retry the identical call" },
      id: { type: "string", description: "The task's id, from list or view" },
      title: { type: "string", description: "The task's name as the user sees it" },
      prompt: { type: "string", description: "What each run does" },
      rrule: { type: "string", description: "The schedule, as an RRULE line in local time" },
      scheduleLabel: { type: "string", description: "A readable name for a custom rule" },
      runMode: { type: "string", enum: [...RUN_MODES], description: "Where each run happens" },
      targetThreadId: { type: "string", description: "existing-task: the conversation to run in" },
      project: { type: "string", enum: ["context", "none"], description: "This conversation's project, or none" },
      model: { type: "string", description: "A connected model id" },
      modelName: { type: "string", description: "The model's display name, for reading only" },
      reasoning: { type: "string", enum: [...REASONING], description: "Reasoning level" },
      notification: { type: "string", enum: [...NOTIFICATIONS], description: "When to tell the user about a run" },
      status: { type: "string", enum: ["active", "paused"], description: "create, update: whether the task runs" },
    },
    required: ["mode"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const service = automationService()
    if (!service) throw new ToolError("Scheduled tasks are not available in this session.")
    const output = await service.handle(input, { sessionID: context.sessionID })
    return { output, title: `Scheduled tasks: ${String(input.mode)}` }
  },
}
