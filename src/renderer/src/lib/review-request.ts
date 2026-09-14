import { ref } from "vue"

/*
 * Asks made from inside the transcript of what only the app shell can do: open
 * the review beside the conversation, or show one file in it. The transcript
 * is drawn far below the shell and raises no events up to it, so it leaves the
 * ask here and the shell, which watches, carries it out.
 */

/** Bumped each time the review is asked for. */
export const reviewRequest = ref(0)

/** The last file asked to be shown, with when, so asking for the same file twice still reads as a change. */
export const fileRequest = ref<{ path: string; at: number }>()

export function requestReview(): void {
  reviewRequest.value++
}

export function requestFile(path: string): void {
  fileRequest.value = { path, at: Date.now() }
}
