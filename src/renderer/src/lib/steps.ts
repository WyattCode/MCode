import { ref } from "vue"

/**
 * Whether the transcript's tool steps are showing.
 *
 * The reference carries a command for this - `command.steps.toggle`, "show or
 * hide steps for the current message" - and the state has to be reachable from
 * outside the rows for a command to be able to move it. Each group kept its own
 * `ref(false)` and nothing else could see it, so there was no way to open the
 * lot without clicking every one.
 *
 * A group still owns whether it is open: this is the value it starts at and the
 * value the command puts it back to, not a lock. Opening one group by hand
 * after running the command leaves the others where they were, which is what
 * makes the command a starting point rather than a mode.
 */
export const stepsOpen = ref(false)

/**
 * Bumped every time the command runs.
 *
 * A group watches this rather than `stepsOpen`, so pressing the command twice -
 * open, closed, open - reaches a group that was opened by hand in between.
 * Watching the boolean alone would miss it, because the boolean would not have
 * changed from that group's point of view.
 */
export const stepsEpoch = ref(0)

export function toggleSteps(): void {
  stepsOpen.value = !stepsOpen.value
  stepsEpoch.value += 1
}
