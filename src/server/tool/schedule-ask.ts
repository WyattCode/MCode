import type { ToolContext } from "./types"

/**
 * The question a model's scheduling call puts before it takes effect.
 *
 * A scheduled prompt starts turns later with nobody watching, so creating or
 * changing one is treated as running a command: it goes through the command
 * bucket (so Deny refuses it and full access lets it through), the middle
 * level hands it to the review rather than waving it through, and a background
 * subagent is refused. An "always" keeps exactly this job and nothing wider -
 * and nothing at all when its text holds `*` or `?`, which a saved rule would
 * read as wildcards.
 */
export async function askToSchedule(context: ToolContext, subject: string): Promise<void> {
  await context.permissions.ask({
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
    kind: "bash",
    title: "Schedule a prompt to run later",
    titleCode: "perm.schedule",
    subject,
    preview: subject,
    directory: context.directory,
    patterns: [subject],
    always: /[*?]/.test(subject) ? [] : [subject],
    patternAsks: true,
  })
}
