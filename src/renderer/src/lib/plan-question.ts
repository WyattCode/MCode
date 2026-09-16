import type { QuestionPrompt } from "@shared/protocol"
import { openStepPath } from "./open-step-path"
import { t } from "./i18n"

/**
 * plan: the plan_exit card, as MiMo draws it.
 *
 * A question tagged with a plan file is not shown in the model's English. MiMo
 * replaces its sentence, its Yes and No and their explanations with the
 * window's own strings and puts 查看方案 under it, so the card reads the same
 * in every language and the plan is one click away. The dock and the transcript
 * both draw such a card, so the rules live here rather than in either.
 */

/** The plan file a question is about, when it is plan_exit's. */
export function planOf(prompt: QuestionPrompt | undefined): string | undefined {
  const file = prompt?.plan?.trim()
  return file || undefined
}

/** The sentence the card shows: the window's own for a plan question, the model's otherwise. */
export function planQuestionText(prompt: QuestionPrompt): string {
  const plan = planOf(prompt)
  return plan ? t("question.planQuestion", { path: plan }) : prompt.question
}

/** The card's heading: MiMo's word for a plan question. */
export function planHeader(prompt: QuestionPrompt): string {
  return planOf(prompt) ? t("question.planHeader") : prompt.header
}

/** Which of plan_exit's two answers a label is; anything the user typed is neither. */
function answerOf(label: string): "yes" | "no" | undefined {
  const word = label.trim().toLowerCase()
  return word === "yes" ? "yes" : word === "no" ? "no" : undefined
}

/** An option's label in the window's language; typed text is left as it was written. */
export function planOptionLabel(prompt: QuestionPrompt, label: string): string {
  if (!planOf(prompt)) return label
  const answer = answerOf(label)
  return answer === "yes" ? t("question.planOptYes") : answer === "no" ? t("question.planOptNo") : label
}

/** An option's explanation, in the window's language. */
export function planOptionDescription(prompt: QuestionPrompt, option: { label: string; description?: string }): string {
  if (!planOf(prompt)) return option.description ?? ""
  const answer = answerOf(option.label)
  return answer === "yes" ? t("question.planOptYesDesc") : answer === "no" ? t("question.planOptNoDesc") : (option.description ?? "")
}

/** 查看方案: the plan opens where a step's path opens, in the files tab beside the conversation. */
export function openPlan(file: string, directory?: string): void {
  void openStepPath(file, directory)
}
