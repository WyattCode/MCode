import { reactive } from "vue"

/*
 * PLACEHOLDER from the stream agent. The reply agent's own file replaces this
 * at merge; keep theirs. It holds the ids of text parts still playing out
 * their paced reveal. Empty here, so the gates in MessageStream that wait on
 * it stay open.
 */
export const revealing = reactive(new Set<string>())
