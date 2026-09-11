<script setup lang="ts">
import { computed, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { latestTodos, type Todo } from "../lib/session-info"

/**
 * The plan, kept where it can be seen.
 *
 * A turn that works to a plan records it with the todowrite tool, and that plan
 * is drawn as a card in the transcript - which then scrolls away under the work
 * it describes. So the one thing that says what is being done, and how much of
 * it is left, was the thing you had to scroll back to find.
 *
 * It sits above the composer, which is where opencode puts it: shut, it is one
 * line naming what is being worked on now; open, it is the whole list.
 */
const app = useApp()

/** The most recent plan in this conversation - the same one the info card shows. */
const todos = computed<Todo[]>(() => latestTodos(app.messages))

const done = computed(() => todos.value.filter((todo) => todo.status === "completed").length)

/**
 * What the shut dock shows: whatever is being worked on, else the next thing
 * waiting, else the last thing finished - so a completed plan still says so
 * rather than emptying.
 */
const active = computed(
  () =>
    todos.value.find((todo) => todo.status === "in_progress") ??
    todos.value.find((todo) => todo.status === "pending") ??
    todos.value[todos.value.length - 1],
)

const open = ref(false)
</script>

<template>
  <div v-if="todos.length" class="dock" :class="{ open }">
    <button
      class="head"
      :aria-expanded="open"
      v-tip="{ label: open ? t('todo.collapse') : t('todo.expand'), placement: 'top' }"
      @click="open = !open"
    >
      <svg class="caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      <span class="progress">{{ t("todo.progress", { done: String(done), total: String(todos.length) }) }}</span>
      <span v-if="!open && active" class="active">{{ active.content }}</span>
    </button>

    <ul v-if="open" class="list">
      <li v-for="todo in todos" :key="todo.id" :class="todo.status">
        <span class="mark" aria-hidden="true" />
        <span class="text">{{ todo.content }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dock {
  /*
   * The same width the composer takes, so the two read as one stack rather than
   * as a panel with a box under it.
   *
   * "The same width" is not `width: 100%`: the composer holds a 24px inset of
   * its own and then caps its contents at 712px (2.0, MiMo's card), and a dock
   * that does neither ends up wider than the box on every window size.
   * Measured at 8..517 against a box of 32..493 while this said 100%, which
   * read as a step in the stack once a second dock landed beside it.
   *
   * On the card's own surface and rule, with a corner between the card's 20
   * and a row's 8, since it is one line tall where the card is three.
   */
  width: calc(100% - 48px);
  max-width: 712px;
  margin: 0 auto 6px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 14px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: start;
}

.head:hover {
  background: var(--surface-hover);
}

/* Points along the row when shut and down when open, the way a disclosure does.
   Rotated from the reading direction so it still points inwards when mirrored. */
.caret {
  flex-shrink: 0;
  color: var(--icon-weak);
  transition: transform 0.15s ease-in-out;
}

[dir="rtl"] .caret {
  transform: rotate(180deg);
}

.dock.open .caret {
  transform: rotate(90deg);
}

.progress {
  flex-shrink: 0;
  color: var(--text-weaker);
  font-size: 11.5px;
  font-weight: 440;
}

/* What is being worked on, when the list itself is not showing. */
.active {
  overflow: hidden;
  color: var(--text-base);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list {
  max-height: 180px;
  padding: 2px 12px 10px;
  overflow-y: auto;
  list-style: none;
}

.list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0;
  color: var(--text-base);
  font-size: 12.5px;
  line-height: 17px;
}

.mark {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin-top: 5.5px;
  background: var(--icon-weaker);
  border-radius: 50%;
}

.list li.in_progress .mark {
  background: var(--accent);
}

.list li.completed .mark {
  background: var(--success);
}

.list li.completed .text {
  color: var(--text-weaker);
  text-decoration: line-through;
}
</style>
